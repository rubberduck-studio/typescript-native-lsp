/**
 * JSON-RPC message types for the LSP methods the proxy reads or writes, and the
 * byte-level framing used on both pipes.
 */
import type { Writable } from 'node:stream';
import type {
	DidChangeConfigurationParams,
	DidChangeTextDocumentParams,
	DidCloseTextDocumentParams,
	DidOpenTextDocumentParams,
	DidSaveTextDocumentParams,
	DocumentDiagnosticParams,
	InitializeParams,
	PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol';

/** Prefix of every request id the proxy itself sends, so their responses can be kept from the client. */
export const ID_PREFIX = 'typescript-native-lsp:';

/** A JSON-RPC message as it travels over the wire; its shape depends on `method`, see `isMethod`. */
export interface Message {
	jsonrpc: '2.0';
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** The parameters of the LSP methods the proxy and its features read or write. */
export interface MethodParams {
	initialize: InitializeParams;
	'workspace/didChangeConfiguration': DidChangeConfigurationParams;
	'textDocument/didOpen': DidOpenTextDocumentParams;
	'textDocument/didChange': DidChangeTextDocumentParams;
	'textDocument/didSave': DidSaveTextDocumentParams;
	'textDocument/didClose': DidCloseTextDocumentParams;
	'textDocument/diagnostic': DocumentDiagnosticParams;
	'textDocument/publishDiagnostics': PublishDiagnosticsParams;
}

export type MethodMessage<M extends keyof MethodParams> = Message & { method: M; params: MethodParams[M] };

/** Narrows a message by method. The proxy trusts both peers to send parameters that match the LSP specification. */
export function isMethod<M extends keyof MethodParams>(message: Message, method: M): message is MethodMessage<M> {
	return method === message.method;
}

/** Builds a message for one of the known methods, with its parameters type-checked. */
export function methodMessage<M extends keyof MethodParams>(method: M, params: MethodParams[M], id?: string): MethodMessage<M> {
	return undefined === id ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
}

/**
 * Receives one complete LSP frame (header and body, as received) and a function
 * that parses its body, so a caller can forward frames it has no interest in
 * without paying for JSON parsing. `parse` throws when the body is not a
 * JSON-RPC 2.0 message.
 */
export type FrameHandler = (frame: Buffer, parse: () => Message) => void;

/** Splits a byte stream into LSP frames without copying more than once per frame. */
export function createFrameReader(onFrame: FrameHandler): { push(chunk: Buffer): void } {
	let chunks: Buffer[] = [];
	let length = 0;
	let frameEnd = -1;
	let headerEnd = -1;
	const joined = (): Buffer => (1 === chunks.length && undefined !== chunks[0] ? chunks[0] : Buffer.concat(chunks, length));
	return {
		push(chunk) {
			chunks.push(chunk);
			length += chunk.length;
			for (;;) {
				if (-1 === frameEnd) {
					const buffer = joined();
					chunks = [buffer];
					headerEnd = buffer.indexOf('\r\n\r\n');
					if (-1 === headerEnd) {
						return;
					}
					const header = buffer.subarray(0, headerEnd).toString('ascii');
					const declared = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
					if (undefined === declared) {
						throw new Error(`LSP frame without Content-Length: ${header}`);
					}
					frameEnd = headerEnd + 4 + Number.parseInt(declared, 10);
				}
				if (length < frameEnd) {
					return;
				}
				const buffer = joined();
				const frame = buffer.subarray(0, frameEnd);
				const rest = buffer.subarray(frameEnd);
				chunks = rest.length > 0 ? [rest] : [];
				length = rest.length;
				const body = frame.subarray(headerEnd + 4);
				frameEnd = -1;
				headerEnd = -1;
				onFrame(frame, () => parseMessage(body));
			}
		},
	};
}

function parseMessage(body: Buffer): Message {
	const parsed: unknown = JSON.parse(body.toString('utf8'));
	if (false === isMessage(parsed)) {
		throw new Error('LSP frame is not a JSON-RPC 2.0 message');
	}
	return parsed;
}

function isMessage(value: unknown): value is Message {
	return 'object' === typeof value && null !== value && 'jsonrpc' in value && '2.0' === value.jsonrpc;
}

/** Writes a message as one LSP frame. */
export function writeMessage(target: Pick<Writable, 'write'>, message: Message): void {
	const body = JSON.stringify(message);
	target.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
