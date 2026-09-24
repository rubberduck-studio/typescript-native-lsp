/**
 * A stand-in for TypeScript's native language server, used by the bridge tests
 * (delete together with scripts/diagnostics-bridge.mjs). It speaks just enough
 * LSP over stdio: initialize, a scripted textDocument/diagnostic, shutdown and
 * exit. FAKE_PULLS lists what each successive pull returns, comma separated:
 * `empty`, `error`, `items`, `related`; the last entry repeats.
 */
const script = (process.env.FAKE_PULLS || 'items').split(',');
let pulls = 0;
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
			respond(message.id, { capabilities: { textDocumentSync: 2, hoverProvider: true, diagnosticProvider: { identifier: 'fake', interFileDependencies: true, workspaceDiagnostics: false } }, serverInfo: { name: 'fake', version: '7.0.2' } });
			return;
		case 'textDocument/diagnostic':
			respondPull(message);
			return;
		case 'shutdown':
			respond(message.id, null);
			return;
		case 'exit':
			process.exit(0);
			return;
		default:
			if (undefined !== message.id) {
				respond(message.id, null);
			}
	}
}

function respondPull(message) {
	const behaviour = script[Math.min(pulls, script.length - 1)];
	pulls += 1;
	const uri = message.params.textDocument.uri;
	const item = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, code: 2322, message: `pull ${pulls}` };
	if ('error' === behaviour) {
		write({ jsonrpc: '2.0', id: message.id, error: { code: -32801, message: 'content modified' } });
		return;
	}
	if ('related' === behaviour) {
		respond(message.id, { kind: 'full', items: [item], relatedDocuments: { [uri.replace(/[^/]+$/, 'other.ts')]: { kind: 'full', items: [{ ...item, code: 2304 }] } } });
		return;
	}
	respond(message.id, { kind: 'full', items: 'empty' === behaviour ? [] : [item] });
}

function respond(id, result) {
	write({ jsonrpc: '2.0', id, result });
}

function write(message) {
	const body = JSON.stringify(message);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
