/**
 * A minimal language server for tests of the proxy's process handling, where
 * a real server cannot be made slow or misbehave on demand. It answers
 * initialize, hover (with its own pid, so a test can tell servers apart),
 * shutdown and exit. Environment:
 * - FAKE_HOVER_DELAY_MS: answer hover requests this much later.
 * - FAKE_SHUTDOWN_DELAY_MS: answer shutdown this much later.
 * - FAKE_PIPE_HOLDER_MS: start a process that keeps this server's stdout open
 *   for that long after the server itself exits, as a wrapper script that does
 *   not exec would.
 */
import { spawn } from 'node:child_process';

const hoverDelay = Number(process.env.FAKE_HOVER_DELAY_MS || 0);
const shutdownDelay = Number(process.env.FAKE_SHUTDOWN_DELAY_MS || 0);
const pipeHolder = Number(process.env.FAKE_PIPE_HOLDER_MS || 0);

if (pipeHolder > 0) {
	spawn(process.execPath, ['-e', `setTimeout(() => {}, ${pipeHolder})`], { stdio: ['ignore', 'inherit', 'ignore'] }).unref();
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf('\r\n\r\n');
		if (-1 === headerEnd) {
			return;
		}
		const length = Number.parseInt(/Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString())[1], 10);
		if (buffer.length < headerEnd + 4 + length) {
			return;
		}
		const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8'));
		buffer = buffer.subarray(headerEnd + 4 + length);
		handle(message);
	}
});

function handle(message) {
	switch (message.method) {
		case 'initialize':
			respond(message.id, { capabilities: { textDocumentSync: 1, hoverProvider: true }, serverInfo: { name: 'fake', version: '7.0.2' } });
			return;
		case 'textDocument/hover':
			setTimeout(() => respond(message.id, { contents: { kind: 'plaintext', value: `fake server ${process.pid}` } }), hoverDelay);
			return;
		case 'shutdown':
			setTimeout(() => respond(message.id, null), shutdownDelay);
			return;
		case 'exit':
			process.exit(0);
		default:
			if (undefined !== message.id) {
				respond(message.id, null);
			}
	}
}

function respond(id, result) {
	const body = JSON.stringify({ jsonrpc: '2.0', id, result });
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
