/**
 * A stdio proxy between Claude Code and a language server.
 *
 * It spawns the server, forwards every frame in both directions, and lets a list
 * of features observe, rewrite, drop or inject messages. Each feature works
 * around one gap between Claude Code's LSP client and the servers, and each can
 * be removed on its own once that gap is closed upstream. With no features left,
 * the proxy itself can go: main.mts then execs the server directly.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import type { Writable } from 'node:stream';
import type {
	DidChangeTextDocumentParams,
	DidCloseTextDocumentParams,
	DidOpenTextDocumentParams,
	DidSaveTextDocumentParams,
	DocumentDiagnosticParams,
	InitializeParams,
	PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol';

const KILL_GRACE_MS = 2000;
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const ID_PREFIX = 'typescript-native-lsp:';

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

export interface ProxyEvents {
	/** Another feature changed a document behind the client's back. */
	changed: string;
	/** Another feature closed a document behind the client's back. */
	closed: string;
	/** The session is ending; release timers. */
	shutdown: undefined;
}

export interface ProxyContext {
	log(message: string): void;
	trace(message: string): void;
	toServer(message: Message): void;
	toClient(message: Message): void;
	/** A request id the proxy recognises and keeps from the client. */
	requestId(name: string): string;
	/** Lets every feature bring the server up to date before a request is sent. */
	beforeRequest(): void;
	on<E extends keyof ProxyEvents>(event: E, handler: (payload: ProxyEvents[E]) => void): void;
	emit<E extends keyof ProxyEvents>(event: E, payload: ProxyEvents[E]): void;
}

export interface Feature {
	/**
	 * A client-to-server message. Return true to forward it as is, false to drop it,
	 * or a message to forward instead. Features see the message in list order, each
	 * receiving the previous feature's result.
	 */
	onClient?(message: Message): boolean | Message;
	/** A server response to a request whose id came from `ctx.requestId`. */
	onServer?(message: Message): void;
	/** Runs before any request reaches the server, the client's and the features' own. */
	beforeRequest?(): void;
}

export type FeatureFactory = (ctx: ProxyContext) => Feature;

export interface ProxyOptions {
	command: string;
	args: string[];
	log(message: string): void;
	debug?: boolean;
	features: FeatureFactory[];
}

export function runProxy({ command, args, log, debug = false, features }: ProxyOptions): void {
	const server = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
	const serverIn = server.stdin;
	const serverOut = server.stdout;
	const listeners: { [E in keyof ProxyEvents]: Array<(payload: ProxyEvents[E]) => void> } = { changed: [], closed: [], shutdown: [] };
	let nextId = 0;

	const ctx: ProxyContext = {
		log,
		trace: debug ? log : () => {},
		toServer: message => writeMessage(serverIn, message),
		toClient: message => writeMessage(process.stdout, message),
		requestId: name => `${ID_PREFIX}${name}:${++nextId}`,
		beforeRequest: () => {
			for (const feature of active) {
				feature.beforeRequest?.();
			}
		},
		on(event, handler) {
			listeners[event].push(handler);
		},
		emit(event, payload) {
			for (const handler of listeners[event]) {
				handler(payload);
			}
		},
	};
	const active = features.map(create => create(ctx));

	const toServer = createFrameReader({
		wants: () => true,
		inspect(message) {
			if (undefined !== message.id && undefined !== message.method) {
				ctx.beforeRequest();
			}
			let current = message;
			let replaced = false;
			for (const feature of active) {
				if (undefined === feature.onClient) {
					continue;
				}
				const result = feature.onClient(current);
				if (false === result) {
					return false;
				}
				if (true !== result) {
					current = result;
					replaced = true;
				}
			}
			return replaced ? current : true;
		},
		target: serverIn,
	});

	const toClient = createFrameReader({
		wants: frame => frame.includes(ID_PREFIX),
		inspect(message) {
			if ('string' !== typeof message.id || false === message.id.startsWith(ID_PREFIX)) {
				return true;
			}
			for (const feature of active) {
				feature.onServer?.(message);
			}
			return false;
		},
		target: process.stdout,
	});

	process.stdin.on('data', (chunk: Buffer) => guard(() => toServer.push(chunk)));
	process.stdin.on('end', () => serverIn.end());
	serverIn.on('error', () => {});
	serverOut.on('data', (chunk: Buffer) => guard(() => toClient.push(chunk)));
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
	forwardSignals(server);

	/** Runs a frame handler; a protocol error ends the session cleanly instead of throwing across the event loop. */
	function guard(handle: () => void): void {
		try {
			handle();
		} catch (error) {
			log(`protocol error: ${error instanceof Error ? error.message : String(error)}`);
			server.kill('SIGTERM');
			finish(1);
		}
	}

	/** Stops everything that keeps the event loop alive; Node exits once stdout has drained. */
	function finish(code: number): void {
		process.exitCode = code;
		process.stdin.destroy();
		ctx.emit('shutdown', undefined);
	}
}

export interface FrameReaderOptions {
	/** Whether a frame can matter to `inspect`; frames it rejects are forwarded unparsed. */
	wants(frame: Buffer): boolean;
	/** True forwards the original bytes, false drops the frame, a message is forwarded instead. */
	inspect(message: Message): boolean | Message;
	target: Pick<Writable, 'write'>;
}

/** Splits a byte stream into LSP frames without copying more than once per frame. */
export function createFrameReader({ wants, inspect, target }: FrameReaderOptions): { push(chunk: Buffer): void } {
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
				const bodyStart = headerEnd + 4;
				frameEnd = -1;
				headerEnd = -1;
				if (false === wants(frame)) {
					target.write(frame);
					continue;
				}
				const parsed: unknown = JSON.parse(frame.subarray(bodyStart).toString('utf8'));
				if (false === isMessage(parsed)) {
					throw new Error('LSP frame is not a JSON-RPC 2.0 message');
				}
				const result = inspect(parsed);
				if (true === result) {
					target.write(frame);
				} else if (false !== result) {
					writeMessage(target, result);
				}
			}
		},
	};
}

/** The exit status a process should report for a child that ended with `code` or `signal`. */
export function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
	if (null !== signal) {
		return 128 + (os.constants.signals[signal] ?? 0);
	}
	return code ?? 1;
}

/** Forwards termination signals to the child, killing it outright if it does not end within a grace period. */
export function forwardSignals(child: ChildProcess): void {
	for (const signal of SIGNALS) {
		process.on(signal, () => {
			child.kill(signal);
			setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
		});
	}
}

function isMessage(value: unknown): value is Message {
	return 'object' === typeof value && null !== value && 'jsonrpc' in value && '2.0' === value.jsonrpc;
}

function writeMessage(target: Pick<Writable, 'write'>, message: Message): void {
	const body = JSON.stringify(message);
	target.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
