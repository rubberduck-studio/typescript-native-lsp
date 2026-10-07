/**
 * Pull-to-push diagnostics bridge for TypeScript's native language server.
 *
 * TODO(upstream): delete this file, its tests, test/helpers/fake-native-server.mjs
 * and its entry in main.mts once either side closes the gap: TypeScript pushing
 * per-file diagnostics for clients without pull support (microsoft/TypeScript#63921),
 * or Claude Code requesting diagnostics itself (anthropics/claude-code#40282). The
 * feature switches itself off once the client sends a textDocument/diagnostic
 * request of its own. It deliberately ignores what the client advertises: a
 * client that claims pull support without pulling would otherwise lose all
 * diagnostics silently, which is worse than briefly receiving them twice.
 *
 * The native server serves per-file diagnostics only on request
 * (textDocument/diagnostic). Claude Code only listens for pushed ones
 * (textDocument/publishDiagnostics). After each didOpen, didChange or didSave,
 * and whenever another feature reports a document changed, this feature requests
 * the file's diagnostics from the server and publishes the result to the client.
 */
import type { Diagnostic, DocumentDiagnosticReport } from 'vscode-languageserver-protocol';
import { isMethod, methodMessage, type Feature, type Message, type ProxyContext } from './proxy.mts';

const DEBOUNCE_MS = 50;
const RETRY_MS = 300;

interface TrackedDocument {
	/** Bumped on every change, so results for superseded content are dropped. */
	generation: number;
	/** The client's version, echoed in published diagnostics. */
	clientVersion: number | null;
	timer: NodeJS.Timeout | null;
}

interface PendingPull {
	uri: string;
	generation: number;
	retried: boolean;
}

export function diagnosticsBridge(ctx: ProxyContext): Feature {
	let enabled = true;
	let firstPullDone = false;
	const documents = new Map<string, TrackedDocument>();
	const pending = new Map<string, PendingPull>();
	const retries = new Set<NodeJS.Timeout>();

	ctx.log('diagnostics bridge on; set TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS=0 to run the server without it');
	ctx.on('changed', uri => {
		if (enabled) {
			schedule(uri, null);
		}
	});
	ctx.on('closed', uri => forget(uri));
	ctx.on('shutdown', () => {
		for (const document of documents.values()) {
			clearTimer(document.timer);
		}
		for (const timer of retries) {
			clearTimeout(timer);
		}
		documents.clear();
	});

	return {
		onClient(message) {
			if (enabled && isMethod(message, 'textDocument/diagnostic')) {
				enabled = false;
				ctx.log('client requests diagnostics itself; bridge disabled');
				for (const uri of [...documents.keys()]) {
					forget(uri);
				}
			}
			if (false === enabled) {
				return true;
			}
			if (isMethod(message, 'textDocument/didOpen') || isMethod(message, 'textDocument/didChange')) {
				schedule(message.params.textDocument.uri, message.params.textDocument.version);
			}
			if (isMethod(message, 'textDocument/didSave')) {
				schedule(message.params.textDocument.uri, null);
			}
			if (isMethod(message, 'textDocument/didClose')) {
				forget(message.params.textDocument.uri);
			}
			return true;
		},
		onServer(message) {
			if ('string' !== typeof message.id) {
				return;
			}
			const request = pending.get(message.id);
			pending.delete(message.id);
			if (undefined !== request) {
				handlePullResult(request, message);
			}
		},
	};

	function schedule(uri: string, clientVersion: number | null): void {
		const document = documents.get(uri) ?? { generation: 0, clientVersion: null, timer: null };
		document.generation += 1;
		if (null !== clientVersion) {
			document.clientVersion = clientVersion;
		}
		clearTimer(document.timer);
		document.timer = setTimeout(() => {
			document.timer = null;
			request(uri, document.generation, false);
		}, DEBOUNCE_MS);
		documents.set(uri, document);
	}

	function forget(uri: string): void {
		clearTimer(documents.get(uri)?.timer ?? null);
		documents.delete(uri);
	}

	function request(uri: string, generation: number, retried: boolean): void {
		ctx.beforeRequest();
		if (documents.get(uri)?.generation !== generation) {
			return;
		}
		const id = ctx.requestId('diagnostics');
		pending.set(id, { uri, generation, retried });
		ctx.trace(`pull ${uri}${retried ? ' (retry)' : ''}`);
		ctx.toServer(methodMessage('textDocument/diagnostic', { textDocument: { uri } }, id));
	}

	/** Re-requests once, later, unless the document changed or was closed in the meantime. */
	function scheduleRetry(uri: string, generation: number): void {
		const timer = setTimeout(() => {
			retries.delete(timer);
			if (documents.get(uri)?.generation === generation) {
				request(uri, generation, true);
			}
		}, RETRY_MS);
		retries.add(timer);
	}

	function handlePullResult({ uri, generation, retried }: PendingPull, message: Message): void {
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
		const report = isReport(message.result) ? message.result : null;
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
			if (false === retried && 'full' === report?.kind && 0 === report.items.length) {
				scheduleRetry(uri, generation);
			}
		}
	}

	function publish(uri: string, version: number | null, diagnostics: Diagnostic[]): void {
		ctx.trace(`publish ${uri}: ${diagnostics.length} item(s)`);
		ctx.toClient(methodMessage('textDocument/publishDiagnostics', null === version ? { uri, diagnostics } : { uri, version, diagnostics }));
	}
}

function isReport(value: unknown): value is DocumentDiagnosticReport {
	return 'object' === typeof value && null !== value && 'kind' in value && ('full' === value.kind || 'unchanged' === value.kind);
}

function clearTimer(timer: NodeJS.Timeout | null): void {
	if (null !== timer) {
		clearTimeout(timer);
	}
}
