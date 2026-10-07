/**
 * Keeps the server's view of the client's open documents in line with disk.
 *
 * TODO(upstream): delete this file, its tests and its entry in main.mts once
 * Claude Code itself sends the new content of open documents whose files change
 * on disk, or closes them. Today it sends nothing for files changed outside its
 * own Edit and Write tools (anthropics/claude-code#76870, #85225) and closes
 * documents only when evicting beyond 50 (anthropics/claude-code#93104), so files
 * changed by shell commands, git, formatters or codegen stay stale.
 *
 * It does not switch itself off on what the client advertises. Claude Code has
 * advertised workspace.didChangeWatchedFiles since 2.1.288 without ever sending
 * it, and file-change events would not help anyway: servers treat an open
 * document as the client's and never re-read it from disk. When disk and server
 * agree this feature sends nothing, so leaving it on costs nothing.
 *
 * Servers treat an open document as authoritative over disk. Claude Code opens a
 * document the first time it edits or queries a file and never closes it, so
 * once a file has been touched, later changes on disk are invisible and a deleted
 * file stays in the program as a ghost. Claude Code has no unsaved buffers, so
 * disk is always the truth: before every request this feature compares each open
 * document with its file, sends the current content as a full-text change when
 * the file changed, closes the document when the file is gone (clearing its
 * diagnostics), and reopens it when the file comes back. It numbers document
 * versions itself, so its own updates and the client's never collide.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TextDocumentContentChangeEvent } from 'vscode-languageserver-protocol';
import { isMethod, methodMessage, type Feature, type Message, type MethodMessage, type ProxyContext } from './proxy.mts';

interface TrackedDocument {
	file: string;
	languageId: string;
	/** The content the server holds, or null when an incremental change made it unknown. */
	text: string | null;
	mtimeMs: number;
	size: number;
	/** The version the server last saw; the proxy's own numbering. */
	version: number;
	open: boolean;
}

export function documentSync(ctx: ProxyContext): Feature {
	const documents = new Map<string, TrackedDocument>();
	ctx.log('document sync on; set TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC=0 to run without it');

	return {
		onClient(message) {
			if (isMethod(message, 'textDocument/didOpen')) {
				return opened(message);
			}
			if (isMethod(message, 'textDocument/didChange')) {
				return changed(message);
			}
			if (isMethod(message, 'textDocument/didClose')) {
				return closed(message);
			}
			return true;
		},
		beforeRequest() {
			for (const [uri, document] of documents) {
				reconcile(uri, document);
			}
		},
	};

	function opened(message: MethodMessage<'textDocument/didOpen'>): boolean | Message {
		const { uri, languageId, text } = message.params.textDocument;
		const file = filePathOf(uri);
		if (null === file) {
			return true;
		}
		const document: TrackedDocument = { file, languageId, text, mtimeMs: 0, size: 0, version: 1, open: true };
		recordStat(document);
		documents.set(uri, document);
		return methodMessage('textDocument/didOpen', { textDocument: { ...message.params.textDocument, version: document.version } });
	}

	function changed(message: MethodMessage<'textDocument/didChange'>): boolean | Message {
		const { uri } = message.params.textDocument;
		const document = documents.get(uri);
		if (undefined === document) {
			return true;
		}
		const text = fullText(message.params.contentChanges);
		document.version += 1;
		document.text = text;
		recordStat(document);
		if (document.open) {
			return methodMessage('textDocument/didChange', { ...message.params, textDocument: { uri, version: document.version } });
		}
		document.open = true;
		ctx.trace(`reopen ${uri} on client change`);
		return methodMessage('textDocument/didOpen', { textDocument: { uri, languageId: document.languageId, version: document.version, text: text ?? readText(document.file) ?? '' } });
	}

	function closed(message: MethodMessage<'textDocument/didClose'>): boolean {
		const { uri } = message.params.textDocument;
		const document = documents.get(uri);
		documents.delete(uri);
		return undefined === document || document.open;
	}

	function reconcile(uri: string, document: TrackedDocument): void {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(document.file);
		} catch (error) {
			if (isMissingFile(error) && document.open) {
				document.open = false;
				ctx.trace(`close ${uri}: gone from disk`);
				ctx.toServer(methodMessage('textDocument/didClose', { textDocument: { uri } }));
				ctx.toClient(methodMessage('textDocument/publishDiagnostics', { uri, diagnostics: [] }));
				ctx.emit('closed', uri);
			}
			return;
		}
		if (document.open && stat.mtimeMs === document.mtimeMs && stat.size === document.size) {
			return;
		}
		const text = readText(document.file);
		if (null === text) {
			return;
		}
		document.mtimeMs = stat.mtimeMs;
		document.size = stat.size;
		if (document.open && text === document.text) {
			return;
		}
		document.text = text;
		document.version += 1;
		if (document.open) {
			ctx.trace(`update ${uri} from disk`);
			ctx.toServer(methodMessage('textDocument/didChange', { textDocument: { uri, version: document.version }, contentChanges: [{ text }] }));
		} else {
			document.open = true;
			ctx.trace(`reopen ${uri}: back on disk`);
			ctx.toServer(methodMessage('textDocument/didOpen', { textDocument: { uri, languageId: document.languageId, version: document.version, text } }));
		}
		ctx.emit('changed', uri);
	}
}

/** The document's new content when the change replaces it entirely, as Claude Code's always do; null for incremental edits. */
function fullText(contentChanges: TextDocumentContentChangeEvent[]): string | null {
	const last = contentChanges.at(-1);
	return undefined !== last && false === 'range' in last ? last.text : null;
}

function recordStat(document: TrackedDocument): void {
	try {
		const stat = fs.statSync(document.file);
		document.mtimeMs = stat.mtimeMs;
		document.size = stat.size;
	} catch {
		document.mtimeMs = 0;
		document.size = -1;
	}
}

function readText(file: string): string | null {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

function filePathOf(uri: string): string | null {
	try {
		return fileURLToPath(uri);
	} catch {
		return null;
	}
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && 'code' in error && 'ENOENT' === error.code;
}
