/**
 * Pull-to-push diagnostics bridge for TypeScript's native language server.
 *
 * TODO(upstream): delete this file, its tests, test/helpers/fake-native-server.mjs
 * and its entry in launch.mjs once either side closes the gap: TypeScript pushing
 * per-file diagnostics for clients without pull support (microsoft/TypeScript#63921),
 * or Claude Code requesting diagnostics itself (anthropics/claude-code#40282). The
 * feature switches itself off when the client advertises pull support.
 *
 * The native server serves per-file diagnostics only on request
 * (textDocument/diagnostic). Claude Code only listens for pushed ones
 * (textDocument/publishDiagnostics). After each didOpen, didChange or didSave,
 * and whenever another feature reports a document changed, this feature requests
 * the file's diagnostics from the server and publishes the result to the client.
 */
const DEBOUNCE_MS = 50;
const RETRY_MS = 300;
const DOCUMENT_METHODS = new Set(['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didSave']);

export function diagnosticsBridge(ctx) {
	let enabled = true;
	let firstPullDone = false;
	/** @type {Map<string, { generation: number, clientVersion: number | null, timer: NodeJS.Timeout | null }>} */
	const documents = new Map();
	/** @type {Map<string, { uri: string, generation: number, retried: boolean }>} */
	const pending = new Map();
	const retries = new Set();

	ctx.log('diagnostics bridge on; set TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS=0 to run the server without it');
	ctx.on('changed', uri => enabled && schedule(uri, undefined));
	ctx.on('closed', uri => forget(uri));
	ctx.on('shutdown', () => {
		for (const document of documents.values()) {
			clearTimeout(document.timer ?? undefined);
		}
		for (const timer of retries) {
			clearTimeout(timer);
		}
		documents.clear();
	});

	return {
		onClient(message) {
			if ('initialize' === message.method && undefined !== message.params?.capabilities?.textDocument?.diagnostic) {
				enabled = false;
				ctx.log('client supports pull diagnostics; bridge disabled');
			}
			if (enabled && DOCUMENT_METHODS.has(message.method)) {
				schedule(message.params.textDocument.uri, message.params.textDocument.version);
			}
			if ('textDocument/didClose' === message.method) {
				forget(message.params.textDocument.uri);
			}
			return true;
		},
		onServer(message) {
			const request = pending.get(message.id);
			pending.delete(message.id);
			if (undefined !== request) {
				handlePullResult(request, message);
			}
		},
	};

	function schedule(uri, clientVersion) {
		const document = documents.get(uri) ?? { generation: 0, clientVersion: null, timer: null };
		document.generation += 1;
		if ('number' === typeof clientVersion) {
			document.clientVersion = clientVersion;
		}
		clearTimeout(document.timer ?? undefined);
		document.timer = setTimeout(() => {
			document.timer = null;
			request(uri, document.generation, false);
		}, DEBOUNCE_MS);
		documents.set(uri, document);
	}

	function forget(uri) {
		clearTimeout(documents.get(uri)?.timer ?? undefined);
		documents.delete(uri);
	}

	function request(uri, generation, retried) {
		ctx.beforeRequest();
		if (documents.get(uri)?.generation !== generation) {
			return;
		}
		const id = ctx.requestId('diagnostics');
		pending.set(id, { uri, generation, retried });
		ctx.trace(`pull ${uri}${retried ? ' (retry)' : ''}`);
		ctx.toServer({ jsonrpc: '2.0', id, method: 'textDocument/diagnostic', params: { textDocument: { uri } } });
	}

	/** Re-requests once, later, unless the document changed or was closed in the meantime. */
	function scheduleRetry(uri, generation) {
		const timer = setTimeout(() => {
			retries.delete(timer);
			if (documents.get(uri)?.generation === generation) {
				request(uri, generation, true);
			}
		}, RETRY_MS);
		retries.add(timer);
	}

	function handlePullResult({ uri, generation, retried }, message) {
		const current = documents.get(uri);
		if (undefined === current || current.generation !== generation) {
			ctx.trace(`drop stale result for ${uri}`);
			return;
		}
		if (undefined !== message.error) {
			ctx.trace(`pull failed for ${uri}: ${message.error.message}`);
			if (false === retried) {
				scheduleRetry(uri, generation);
			}
			return;
		}
		const report = message.result;
		if ('full' === report?.kind) {
			publish(uri, current.clientVersion, report.items);
		}
		for (const [relatedUri, related] of Object.entries(report?.relatedDocuments ?? {})) {
			if ('full' === related.kind) {
				publish(relatedUri, null, related.items);
			}
		}
		if (false === firstPullDone) {
			firstPullDone = true;
			if (false === retried && 0 === (report?.items?.length ?? 0)) {
				scheduleRetry(uri, generation);
			}
		}
	}

	function publish(uri, version, diagnostics) {
		ctx.trace(`publish ${uri}: ${diagnostics.length} item(s)`);
		const params = { uri, diagnostics };
		if (null !== version) {
			params.version = version;
		}
		ctx.toClient({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params });
	}
}
