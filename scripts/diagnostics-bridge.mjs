/**
 * Pull-to-push diagnostics bridge for TypeScript's native language server.
 *
 * TODO(upstream): delete this file, its tests and the branch in launch.mjs once
 * either side closes the gap: TypeScript pushing per-file diagnostics for clients
 * without pull support (microsoft/TypeScript#63921), or Claude Code requesting
 * diagnostics itself (anthropics/claude-code#40282). The bridge already switches
 * itself off when the client advertises pull support.
 *
 * The native server serves per-file diagnostics only on request
 * (textDocument/diagnostic). Claude Code only listens for pushed ones
 * (textDocument/publishDiagnostics). This bridge sits between the two: it forwards
 * every frame unchanged in both directions, and after each didOpen, didChange or
 * didSave it requests the file's diagnostics from the server and publishes the
 * result to the client. The client never sees the requests, the server never sees
 * anything it would not see from an editor.
 */
import { spawn } from 'node:child_process';

const DEBOUNCE_MS = 50;
const RETRY_MS = 300;
const DOCUMENT_METHODS = new Set(['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didSave']);
const ID_PREFIX = 'typescript-native-lsp:diagnostics:';

/**
 * Runs the server as a child and bridges stdio. Never returns; the process exits
 * with the server's status.
 *
 * @param {{ command: string, args: string[], shell: boolean, log: (message: string) => void, debug?: boolean }} options
 */
export function runBridge({ command, args, shell, log, debug = false }) {
	const server = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], shell, windowsHide: true });
	const trace = debug ? log : () => {};

	let enabled = true;
	let nextId = 0;
	let firstPullDone = false;
	/** @type {Map<string, { version: number | null, timer: NodeJS.Timeout | null }>} */
	const documents = new Map();
	/** @type {Map<string, { uri: string, version: number | null, retried: boolean }>} */
	const pending = new Map();

	const toServer = createFrameReader(message => {
		if ('initialize' === message.method && undefined !== message.params?.capabilities?.textDocument?.diagnostic) {
			enabled = false;
			log('client supports pull diagnostics; bridge disabled');
		}
		if (enabled && DOCUMENT_METHODS.has(message.method)) {
			noteDocument(message.params.textDocument);
		}
		if ('textDocument/didClose' === message.method) {
			forgetDocument(message.params.textDocument.uri);
		}
		return true;
	}, server.stdin);

	const toClient = createFrameReader(message => {
		if ('string' !== typeof message.id || false === message.id.startsWith(ID_PREFIX)) {
			return true;
		}
		const request = pending.get(message.id);
		pending.delete(message.id);
		if (undefined !== request) {
			handlePullResult(request, message);
		}
		return false;
	}, process.stdout);

	process.stdin.on('data', toServer.push);
	process.stdin.on('end', () => server.stdin.end());
	server.stdout.on('data', toClient.push);
	server.on('error', error => {
		log(`failed to start ${command}: ${error.message}`);
		process.exit(1);
	});
	server.on('exit', (code, signal) => {
		if (null !== signal) {
			log(`server exited on ${signal}`);
			process.kill(process.pid, signal);
			return;
		}
		process.exit(code ?? 1);
	});
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
		process.on(signal, () => server.kill(signal));
	}
	log('diagnostics bridge on; set TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS=0 to run the server without it');

	function noteDocument(textDocument) {
		const { uri } = textDocument;
		const document = documents.get(uri) ?? { version: null, timer: null };
		if ('number' === typeof textDocument.version) {
			document.version = textDocument.version;
		}
		if (null !== document.timer) {
			clearTimeout(document.timer);
		}
		document.timer = setTimeout(() => {
			document.timer = null;
			requestDiagnostics(uri, document.version, false);
		}, DEBOUNCE_MS);
		documents.set(uri, document);
	}

	function forgetDocument(uri) {
		const document = documents.get(uri);
		if (undefined === document) {
			return;
		}
		if (null !== document.timer) {
			clearTimeout(document.timer);
		}
		documents.delete(uri);
	}

	function requestDiagnostics(uri, version, retried) {
		const id = ID_PREFIX + ++nextId;
		pending.set(id, { uri, version, retried });
		trace(`pull ${uri} v${version}${retried ? ' (retry)' : ''}`);
		writeMessage(server.stdin, { jsonrpc: '2.0', id, method: 'textDocument/diagnostic', params: { textDocument: { uri } } });
	}

	function handlePullResult(request, message) {
		const { uri, version, retried } = request;
		const current = documents.get(uri);
		if (undefined === current || current.version !== version) {
			trace(`drop stale result for ${uri} v${version}`);
			return;
		}
		if (undefined !== message.error) {
			trace(`pull failed for ${uri}: ${message.error.message}`);
			if (false === retried) {
				setTimeout(() => requestDiagnostics(uri, version, true), RETRY_MS);
			}
			return;
		}
		const report = message.result;
		if ('full' === report?.kind) {
			publish(uri, version, report.items);
		}
		for (const [relatedUri, related] of Object.entries(report?.relatedDocuments ?? {})) {
			if ('full' === related.kind) {
				publish(relatedUri, null, related.items);
			}
		}
		if (false === firstPullDone) {
			firstPullDone = true;
			if (false === retried && 0 === (report?.items?.length ?? 0)) {
				setTimeout(() => requestDiagnostics(uri, version, true), RETRY_MS);
			}
		}
	}

	function publish(uri, version, diagnostics) {
		trace(`publish ${uri} v${version}: ${diagnostics.length} item(s)`);
		const params = { uri, diagnostics };
		if (null !== version) {
			params.version = version;
		}
		writeMessage(process.stdout, { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params });
	}
}

/**
 * Splits a byte stream into LSP frames. Each complete frame is parsed and offered
 * to `inspect`; when that returns true the original bytes are written to `target`
 * unchanged, so forwarded traffic is never re-serialised.
 */
export function createFrameReader(inspect, target) {
	let buffer = Buffer.alloc(0);
	return {
		push(chunk) {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				const headerEnd = buffer.indexOf('\r\n\r\n');
				if (-1 === headerEnd) {
					return;
				}
				const header = buffer.subarray(0, headerEnd).toString('ascii');
				const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
				if (null === lengthMatch) {
					throw new Error(`LSP frame without Content-Length: ${header}`);
				}
				const frameEnd = headerEnd + 4 + Number.parseInt(lengthMatch[1], 10);
				if (buffer.length < frameEnd) {
					return;
				}
				const frame = buffer.subarray(0, frameEnd);
				buffer = buffer.subarray(frameEnd);
				const message = JSON.parse(frame.subarray(headerEnd + 4).toString('utf8'));
				if (inspect(message)) {
					target.write(frame);
				}
			}
		},
	};
}

function writeMessage(target, message) {
	const body = JSON.stringify(message);
	target.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
