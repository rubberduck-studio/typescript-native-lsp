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
import os from 'node:os';

const DEBOUNCE_MS = 50;
const RETRY_MS = 300;
const KILL_GRACE_MS = 2000;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const DOCUMENT_METHODS = new Set(['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didSave']);
const ID_PREFIX = 'typescript-native-lsp:diagnostics:';

/**
 * Runs the server as a child and bridges stdio. Returns once the child has been
 * spawned; the process exits with the server's status when the server ends.
 *
 * @param {{ command: string, args: string[], log: (message: string) => void, debug?: boolean }} options
 */
export function runBridge({ command, args, log, debug = false }) {
	const server = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
	const trace = debug ? log : () => {};

	let enabled = true;
	let nextId = 0;
	let firstPullDone = false;
	/** @type {Map<string, { version: number | null, timer: NodeJS.Timeout | null }>} */
	const documents = new Map();
	/** @type {Map<string, { uri: string, version: number | null, retried: boolean }>} */
	const pending = new Map();
	const retries = new Set();

	const toServer = createFrameReader({
		wants: () => true,
		inspect(message) {
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
		},
		target: server.stdin,
	});

	const toClient = createFrameReader({
		wants: frame => frame.includes(ID_PREFIX),
		inspect(message) {
			if ('string' !== typeof message.id || false === message.id.startsWith(ID_PREFIX)) {
				return true;
			}
			const request = pending.get(message.id);
			pending.delete(message.id);
			if (undefined !== request) {
				handlePullResult(request, message);
			}
			return false;
		},
		target: process.stdout,
	});

	process.stdin.on('data', chunk => guard(() => toServer.push(chunk)));
	process.stdin.on('end', () => server.stdin.end());
	server.stdin.on('error', () => {});
	server.stdout.on('data', chunk => guard(() => toClient.push(chunk)));
	server.on('error', error => {
		log(`failed to start ${command}: ${error.message}`);
		finish(1);
	});
	server.on('close', (code, signal) => {
		if (null !== signal) {
			log(`server exited on ${signal}`);
		}
		finish(exitStatus(code, signal));
	});
	for (const signal of SIGNALS) {
		process.on(signal, () => {
			server.kill(signal);
			setTimeout(() => server.kill('SIGKILL'), KILL_GRACE_MS).unref();
		});
	}
	log('diagnostics bridge on; set TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS=0 to run the server without it');

	/** Runs a frame handler; a protocol error ends the session cleanly instead of throwing across the event loop. */
	function guard(handle) {
		try {
			handle();
		} catch (error) {
			log(`protocol error: ${error.message}`);
			server.kill('SIGTERM');
			finish(1);
		}
	}

	/** Stops everything that keeps the event loop alive; Node exits once stdout has drained. */
	function finish(code) {
		process.exitCode = code;
		process.stdin.destroy();
		for (const document of documents.values()) {
			if (null !== document.timer) {
				clearTimeout(document.timer);
			}
		}
		for (const timer of retries) {
			clearTimeout(timer);
		}
		documents.clear();
	}

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

	/** Re-requests once, later, unless the document changed or was closed in the meantime. */
	function scheduleRetry(uri, version) {
		const timer = setTimeout(() => {
			retries.delete(timer);
			const current = documents.get(uri);
			if (undefined !== current && current.version === version) {
				requestDiagnostics(uri, version, true);
			}
		}, RETRY_MS);
		retries.add(timer);
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
				scheduleRetry(uri, version);
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
				scheduleRetry(uri, version);
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
 * Splits a byte stream into LSP frames without copying more than once per frame.
 * A complete frame is handed to `inspect` (parsed) only when `wants(frame)` says
 * the frame can matter; frames `inspect` returns true for, and frames it never
 * saw, are written to `target` unchanged, so forwarded traffic is never
 * re-serialised.
 */
export function createFrameReader({ wants, inspect, target }) {
	let chunks = [];
	let length = 0;
	let frameEnd = -1;
	let headerEnd = -1;
	return {
		push(chunk) {
			chunks.push(chunk);
			length += chunk.length;
			for (;;) {
				if (-1 === frameEnd) {
					const joined = 1 === chunks.length ? chunks[0] : Buffer.concat(chunks, length);
					chunks = [joined];
					headerEnd = joined.indexOf('\r\n\r\n');
					if (-1 === headerEnd) {
						return;
					}
					const header = joined.subarray(0, headerEnd).toString('ascii');
					const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
					if (null === lengthMatch) {
						throw new Error(`LSP frame without Content-Length: ${header}`);
					}
					frameEnd = headerEnd + 4 + Number.parseInt(lengthMatch[1], 10);
				}
				if (length < frameEnd) {
					return;
				}
				const joined = 1 === chunks.length ? chunks[0] : Buffer.concat(chunks, length);
				const frame = joined.subarray(0, frameEnd);
				const rest = joined.subarray(frameEnd);
				chunks = rest.length > 0 ? [rest] : [];
				length = rest.length;
				const bodyStart = headerEnd + 4;
				frameEnd = -1;
				headerEnd = -1;
				if (false === wants(frame) || inspect(JSON.parse(frame.subarray(bodyStart).toString('utf8')))) {
					target.write(frame);
				}
			}
		},
	};
}

export function exitStatus(code, signal) {
	if (null !== signal) {
		return 128 + (os.constants.signals[signal] ?? 0);
	}
	return code ?? 1;
}

function writeMessage(target, message) {
	const body = JSON.stringify(message);
	target.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
