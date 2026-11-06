/**
 * A minimal language server for tests of the proxy's process handling, where
 * a real server cannot be made slow or misbehave on demand. It answers
 * initialize, shutdown and exit, tracks open documents and the last
 * configuration, and answers hover with `fake server <pid> <state>`, where state
 * is JSON of the open documents' versions and the configuration, so a test can
 * tell servers apart and see what a restarted one was given. A `fake/exit`
 * request ends the process with the code in its params. Environment:
 * - FAKE_HOVER_DELAY_MS: answer hover requests this much later.
 * - FAKE_SHUTDOWN_DELAY_MS: answer shutdown this much later.
 * - FAKE_IGNORE_SHUTDOWN=1: never answer shutdown.
 * - FAKE_IGNORE_EXIT=1: stay alive after exit and after the end of input, for
 *   at most 30 seconds, so a test that goes wrong leaves no process behind.
 * - FAKE_IGNORE_SIGTERM=1: survive SIGTERM, so only SIGKILL ends it.
 * - FAKE_FAIL_FILE: exit 1 at startup while this file exists, after
 *   FAKE_FAIL_DELAY_MS (default 0) and without answering initialize.
 * - FAKE_HANG_FILE: never answer initialize while this file exists.
 * - FAKE_PID_FILE: append the process id to this file at startup.
 * - FAKE_PIPE_HOLDER_MS: start a process that keeps this server's stdout open
 *   for that long after the server itself exits, as a wrapper script that does
 *   not exec would.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const hoverDelay = Number(process.env.FAKE_HOVER_DELAY_MS || 0);
const shutdownDelay = Number(process.env.FAKE_SHUTDOWN_DELAY_MS || 0);
const ignoreShutdown = '1' === process.env.FAKE_IGNORE_SHUTDOWN;
const ignoreExit = '1' === process.env.FAKE_IGNORE_EXIT;
const pipeHolder = Number(process.env.FAKE_PIPE_HOLDER_MS || 0);
const hang = undefined !== process.env.FAKE_HANG_FILE && fs.existsSync(process.env.FAKE_HANG_FILE);

const failing = undefined !== process.env.FAKE_FAIL_FILE && fs.existsSync(process.env.FAKE_FAIL_FILE);
if (failing && 0 === Number(process.env.FAKE_FAIL_DELAY_MS || 0)) {
	process.exit(1);
}
if (failing) {
	setTimeout(() => process.exit(1), Number(process.env.FAKE_FAIL_DELAY_MS));
}
if ('1' === process.env.FAKE_IGNORE_SIGTERM) {
	process.on('SIGTERM', () => {});
}
if (undefined !== process.env.FAKE_PID_FILE) {
	fs.appendFileSync(process.env.FAKE_PID_FILE, `${process.pid}\n`);
}
if (pipeHolder > 0) {
	spawn(process.execPath, ['-e', `setTimeout(() => {}, ${pipeHolder})`], { stdio: ['ignore', 'inherit', 'ignore'], cwd: os.tmpdir() }).unref();
}
if (ignoreExit) {
	setTimeout(() => process.exit(0), 30000);
}

const open = {};
let config = null;
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
			if (false === hang && false === failing) {
				respond(message.id, { capabilities: { textDocumentSync: 1, hoverProvider: true }, serverInfo: { name: 'fake', version: '7.0.2' } });
			}
			return;
		case 'textDocument/didOpen':
			open[message.params.textDocument.uri] = message.params.textDocument.version;
			return;
		case 'textDocument/didChange':
			open[message.params.textDocument.uri] = message.params.textDocument.version;
			return;
		case 'textDocument/didClose':
			delete open[message.params.textDocument.uri];
			return;
		case 'workspace/didChangeConfiguration':
			config = message.params.settings;
			return;
		case 'textDocument/hover':
			setTimeout(() => respond(message.id, { contents: { kind: 'plaintext', value: `fake server ${process.pid} ${JSON.stringify({ open, config })}` } }), hoverDelay);
			return;
		case 'fake/exit':
			process.exit(message.params.code);
		case 'shutdown':
			if (false === ignoreShutdown) {
				setTimeout(() => respond(message.id, null), shutdownDelay);
			}
			return;
		case 'exit':
			if (false === ignoreExit) {
				process.exit(0);
			}
			return;
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
