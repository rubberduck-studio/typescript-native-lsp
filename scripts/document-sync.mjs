/**
 * Keeps the server's view of the client's open documents in line with disk.
 *
 * TODO(upstream): delete this file, its tests and its entry in launch.mjs once
 * Claude Code tells servers about files changed outside its own Edit and Write
 * tools: it sends no workspace/didChangeWatchedFiles (anthropics/claude-code#85225)
 * and no textDocument/didClose (anthropics/claude-code#93104), so files changed by
 * shell commands, git, formatters or codegen stay stale for the whole session
 * (anthropics/claude-code#76870). The feature switches itself off when the client
 * advertises file watching.
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

export function documentSync(ctx) {
	let enabled = true;
	/** @type {Map<string, { file: string, languageId: string, text: string | null, mtimeMs: number, size: number, version: number, open: boolean }>} */
	const documents = new Map();
	ctx.log('document sync on; set TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC=0 to run without it');

	return {
		onClient(message) {
			if ('initialize' === message.method && undefined !== message.params?.capabilities?.workspace?.didChangeWatchedFiles) {
				enabled = false;
				ctx.log('client watches files itself; document sync disabled');
				return true;
			}
			if (false === enabled) {
				return true;
			}
			switch (message.method) {
				case 'textDocument/didOpen':
					return opened(message);
				case 'textDocument/didChange':
					return changed(message);
				case 'textDocument/didClose':
					return closed(message);
				default:
					return true;
			}
		},
		beforeRequest() {
			if (false === enabled) {
				return;
			}
			for (const [uri, document] of documents) {
				reconcile(uri, document);
			}
		},
	};

	function opened(message) {
		const { uri, languageId, text } = message.params.textDocument;
		const file = filePathOf(uri);
		if (null === file) {
			return true;
		}
		const document = { file, languageId, text, mtimeMs: 0, size: 0, version: 1, open: true };
		recordStat(document);
		documents.set(uri, document);
		return withVersion(message, document.version);
	}

	function changed(message) {
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
			return withVersion(message, document.version);
		}
		document.open = true;
		ctx.trace(`reopen ${uri} on client change`);
		return { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: document.languageId, version: document.version, text: text ?? readText(document.file) ?? '' } } };
	}

	function closed(message) {
		const document = documents.get(message.params.textDocument.uri);
		documents.delete(message.params.textDocument.uri);
		return undefined === document || document.open;
	}

	function reconcile(uri, document) {
		let stat;
		try {
			stat = fs.statSync(document.file);
		} catch (error) {
			if ('ENOENT' === error.code && document.open) {
				document.open = false;
				ctx.trace(`close ${uri}: gone from disk`);
				ctx.toServer({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } });
				ctx.toClient({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
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
			ctx.toServer({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: document.version }, contentChanges: [{ text }] } });
		} else {
			document.open = true;
			ctx.trace(`reopen ${uri}: back on disk`);
			ctx.toServer({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: document.languageId, version: document.version, text } } });
		}
		ctx.emit('changed', uri);
	}
}

function withVersion(message, version) {
	const { textDocument } = message.params;
	return { ...message, params: { ...message.params, textDocument: { ...textDocument, version } } };
}

/** The document's new content when the change replaces it entirely, as Claude Code's always do; null for incremental edits. */
function fullText(contentChanges) {
	const last = contentChanges.at(-1);
	return undefined !== last && undefined === last.range ? last.text : null;
}

function recordStat(document) {
	try {
		const stat = fs.statSync(document.file);
		document.mtimeMs = stat.mtimeMs;
		document.size = stat.size;
	} catch {
		document.mtimeMs = 0;
		document.size = -1;
	}
}

function readText(file) {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

function filePathOf(uri) {
	try {
		return fileURLToPath(uri);
	} catch {
		return null;
	}
}
