/**
 * The language server as a child process of the proxy, with idle shutdown.
 *
 * TypeScript's servers hold on to the memory of every project they have loaded,
 * several GB for a large monorepo, until they exit, and Claude Code keeps its
 * language servers running until the session ends. With idle shutdown on, the
 * server is stopped once the client has been quiet for the idle period and no
 * request is waiting for an answer, and started again when the client next needs
 * it. The new server gets the client's original initialize parameters, its last
 * configuration, and every document the old server had open, with the same text
 * and versions, so the client sees nothing but a first request as slow as after
 * a cold start.
 *
 * Activity is what the client sends, including what the proxy's features send on
 * its behalf, and the server's answers to it: responses to requests, and for a
 * server that pushes diagnostics, its diagnostics for a document after the
 * document was opened or changed. Messages a server sends on its own do not
 * count: servers log and report progress unprompted (TypeScript's native server
 * logs every file watcher event), and counting that would keep a server running
 * forever in a busy repository. An answer still missing after five minutes is
 * taken as never coming, since Claude Code gives up on requests after 60 seconds.
 *
 * TODO(upstream): drop the idle handling (the stop, the record of open documents
 * and the replay) once Claude Code stops idle language servers itself
 * (anthropics/claude-code#104477, #35276).
 *
 * While the server is stopped or being restarted:
 * - didOpen, didChange and didClose update the record of open documents, which
 *   the restart replays. Forwarding them later instead would send changes and
 *   closes for documents the new server never saw open. Once a message is queued,
 *   later ones queue behind it instead, so a request is answered against the
 *   documents as they were when it was sent.
 * - didOpen and didChange also start the server: servers that push diagnostics
 *   do so after a change, and Claude Code waits for them after an edit without
 *   sending a request.
 * - didSave is dropped, and didChangeConfiguration is kept for the replay.
 * - Requests are queued and start the server; other notifications are queued.
 * - Responses to requests of the stopped server are dropped.
 * - The client's shutdown is answered by the proxy, and its exit (or the end of
 *   its input) ends the proxy, without starting a server just to stop it.
 *
 * Each restart resolves the server again, so a reinstall or branch switch while
 * the server was stopped is picked up. A server that cannot be started (its files
 * gone in the middle of a reinstall, or one that does not answer initialize
 * within a minute) leaves the proxy running: queued document changes go into the
 * record, queued requests are answered with ContentModified, which Claude Code
 * retries, and the next request tries again. When the project now needs the other
 * kind of server (TypeScript 7 instead of 6 or back), the proxy ends with a
 * failure status instead, so Claude Code starts the launcher again with the
 * features that server needs.
 */
import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { InitializeParams, TextDocumentContentChangeEvent } from 'vscode-languageserver-protocol';
import { createFrameReader, ID_PREFIX, isMethod, methodMessage, writeMessage, type Message } from './protocol.mts';

const GRACE_MS = 2000;
/** As long as Claude Code waits for a language server to start (startupTimeout in .lsp.json). */
const STARTUP_TIMEOUT_MS = 60 * 1000;
const ABANDONED_MS = 5 * 60 * 1000;
/** The longest delay Node's timers accept; longer ones fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const LIFECYCLE_PREFIX = `${ID_PREFIX}lifecycle:`;
/** JSON-RPC error codes from the LSP specification. */
const REQUEST_CANCELLED = -32800;
const CONTENT_MODIFIED = -32801;

type ServerProcess = ChildProcessByStdio<Writable, Readable, null>;
type RequestId = number | string;

/**
 * - running: messages go straight to the server.
 * - stopping: idle shutdown is in progress; the server still answers what it already has.
 * - stopped: no server process.
 * - starting: a new server is being initialized and will receive the replay, then the queue.
 */
type State = 'running' | 'stopping' | 'stopped' | 'starting';

interface OpenDocument {
	languageId: string;
	version: number;
	/** The content the server holds, or null when an incremental change made it unknown; the replay then reads the file. */
	text: string | null;
}

interface Queued {
	message: Message;
	frame: Buffer | undefined;
}

export interface ServerCommand {
	command: string;
	args: string[];
	/** TypeScript's own language server (7 or newer), which serves diagnostics on request; otherwise one that publishes them on its own after a change, as typescript-language-server does. */
	native: boolean;
}

export interface ServerOptions {
	/** The server to start first. */
	server: ServerCommand;
	/** Resolves the server again for a restart. Throws when there is none. */
	resolveServer(): ServerCommand;
	/** Stop the server after this many milliseconds of inactivity; 0 keeps it running until the session ends. */
	idleMs: number;
	/** Where the server's messages for the client go. */
	output: Pick<Writable, 'write'>;
	log(message: string): void;
	trace(message: string): void;
	/** A server response to a request whose id the proxy's features made with ID_PREFIX. */
	onOwnResponse(message: Message): void;
	/** A new server has been initialized in place of one stopped for being idle. */
	onRestart(): void;
	/** The session is over: the server exited on its own, failed, or the client ended. The proxy should exit with this status. */
	onExit(code: number): void;
}

export interface Server {
	/** Sends a message to the server, starting one first if it was stopped. `frame` is the message's original bytes, written unchanged when given. */
	send(message: Message, frame?: Buffer): void;
	/** The client closed its end: lets the server exit by closing its input. */
	end(): void;
	/** Passes a termination signal on to the server, killing it outright if it is still running after a grace period. */
	kill(signal: NodeJS.Signals): void;
}

export function startServer(options: ServerOptions): Server {
	const { idleMs, output, log, trace } = options;
	let { command, args } = options.server;
	const { native } = options.server;
	/** Whether to wait for the diagnostics a server publishes on its own before counting it idle. */
	const pushesDiagnostics = false === native;
	const documents = new Map<string, OpenDocument>();
	const queue: Queued[] = [];
	/** Requests the current server has not answered yet, with the time each was sent. */
	const outstanding = new Map<RequestId, number>();
	/** Documents whose diagnostics a pushing server owes after an open or change, keyed by documentKey, with the time of the change. */
	const awaitingDiagnostics = new Map<string, number>();
	let initializeParams: InitializeParams | null = null;
	let configuration: Message | null = null;
	let state: State = 'running';
	let child: ServerProcess | null = spawnServer();
	/** Why the session is ending, once it is: the client's exit (or end of input), or a signal. */
	let ending: 'exit' | 'signal' | null = null;
	/** The proxy has answered the client's shutdown itself; nothing starts a server after that. */
	let shutdownAnswered = false;
	/** A message arrived while the server was being stopped that needs a server once it is gone. */
	let restartWanted = false;
	let lastActivity = performance.now();
	let idleTimer: NodeJS.Timeout | null = null;
	let graceTimer: NodeJS.Timeout | null = null;
	let startupTimer: NodeJS.Timeout | null = null;
	let pendingShutdown: string | null = null;
	let pendingInitialize: string | null = null;
	let nextId = 0;

	if (idleMs > 0) {
		log(`idle shutdown after ${formatDuration(idleMs)} without activity; set the plugin option idle_shutdown_seconds to 0 in /config to keep the server running`);
	}

	return {
		send(message, frame) {
			lastActivity = performance.now();
			if (isMethod(message, 'initialize')) {
				initializeParams = message.params;
			}
			if (isMethod(message, 'workspace/didChangeConfiguration')) {
				configuration = message;
			}
			const wakes = isRequest(message) || isMethod(message, 'textDocument/didOpen') || isMethod(message, 'textDocument/didChange');
			if ('running' === state && null !== child) {
				write(child, message, frame);
				if ('initialized' === message.method) {
					armIdleTimer(idleMs);
				}
				return;
			}
			if (isDocumentNotification(message)) {
				if (0 === queue.length) {
					record(message);
				} else {
					queue.push({ message, frame });
				}
				wake(wakes);
				return;
			}
			if ('textDocument/didSave' === message.method || 'workspace/didChangeConfiguration' === message.method) {
				return;
			}
			if (undefined === message.method) {
				trace(`drop a response for the stopped server (id ${String(message.id)})`);
				return;
			}
			if ('starting' !== state && 'shutdown' === message.method && isRequest(message)) {
				answerShutdown(message.id);
				return;
			}
			if ('starting' !== state && 'exit' === message.method) {
				clientEnded();
				return;
			}
			queue.push({ message, frame });
			wake(wakes);
		},
		end() {
			if ('running' !== state && 'starting' !== state) {
				clientEnded();
				return;
			}
			if ('starting' === state) {
				ending ??= 'exit';
			}
			const server = child;
			server?.stdin.end();
			// A server that ignores the end of its input is ended the hard way.
			setTimeout(() => {
				if (null !== server) {
					terminate(server);
				}
			}, GRACE_MS).unref();
		},
		kill(signal) {
			ending = 'signal';
			if (null === child) {
				finish(exitStatus(null, signal));
				return;
			}
			terminate(child, signal);
		},
	};

	function spawnServer(): ServerProcess {
		const server = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
		server.on('spawn', () => trace(`server started: ${command}`));
		const reader = createFrameReader((frame, parse) => fromServer(frame, parse));
		server.stdin.on('error', () => {});
		server.stdout.on('data', (chunk: Buffer) => {
			try {
				reader.push(chunk);
			} catch (error) {
				log(`protocol error from the server: ${error instanceof Error ? error.message : String(error)}`);
				finish(1);
				terminate(server);
			}
		});
		server.on('error', error => {
			if (server !== child) {
				return;
			}
			if ('starting' === state) {
				restartFailed(error.message);
				return;
			}
			log(`failed to start ${command}: ${error.message}`);
			finish(1);
		});
		// 'close' waits for the server's pipes as well as the process. Should a process the server started keep
		// those open after the server exits, close them, so the proxy does not wait for that process forever.
		server.on('exit', () => {
			setTimeout(() => {
				server.stdout.destroy();
				server.stdin.destroy();
			}, GRACE_MS).unref();
		});
		server.on('close', (code, signal) => closed(server, code, signal));
		return server;
	}

	function fromServer(frame: Buffer, parse: () => Message): void {
		const own = frame.includes(ID_PREFIX);
		const diagnostics = awaitingDiagnostics.size > 0 && frame.includes('textDocument/publishDiagnostics');
		if (false === own && false === diagnostics && 0 === outstanding.size) {
			output.write(frame);
			return;
		}
		const message = parse();
		if (undefined === message.method && undefined !== message.id && null !== message.id) {
			answered(message.id);
		} else if (isMethod(message, 'textDocument/publishDiagnostics')) {
			published(message.params.uri);
		}
		if (false === own || 'string' !== typeof message.id || false === message.id.startsWith(ID_PREFIX)) {
			output.write(frame);
		} else if (message.id === pendingShutdown) {
			sendExit();
		} else if (message.id === pendingInitialize) {
			pendingInitialize = null;
			initialized(message);
		} else if (false === message.id.startsWith(LIFECYCLE_PREFIX)) {
			options.onOwnResponse(message);
		}
	}

	function closed(server: ServerProcess, code: number | null, signal: NodeJS.Signals | null): void {
		if (server !== child) {
			return;
		}
		child = null;
		outstanding.clear();
		awaitingDiagnostics.clear();
		clearTimers();
		if ('signal' === ending || 'running' === state) {
			if (null !== signal) {
				log(`server exited on ${signal}`);
			}
			finish(exitStatus(code, signal));
			return;
		}
		if ('exit' === ending) {
			finish(0);
			return;
		}
		if ('starting' === state) {
			restartFailed(`it exited during startup with ${null === signal ? `code ${String(code)}` : signal}`);
			return;
		}
		state = 'stopped';
		trace('server stopped');
		if (restartWanted) {
			restart();
		}
	}

	/** Writes a message to a running server, keeping the record of open documents and of unanswered requests. */
	function write(server: ServerProcess, message: Message, frame: Buffer | undefined): void {
		record(message);
		if (idleMs > 0 && isRequest(message)) {
			outstanding.set(message.id, performance.now());
		}
		if (isMethod(message, 'textDocument/didOpen') || isMethod(message, 'textDocument/didChange')) {
			awaitDiagnostics(message.params.textDocument.uri);
		} else if (isMethod(message, 'textDocument/didClose')) {
			awaitingDiagnostics.delete(documentKey(message.params.textDocument.uri));
		}
		if (undefined === frame) {
			writeMessage(server.stdin, message);
		} else {
			server.stdin.write(frame);
		}
	}

	function answered(id: RequestId): void {
		if (outstanding.delete(id)) {
			settle();
		}
	}

	function awaitDiagnostics(uri: string): void {
		if (idleMs > 0 && pushesDiagnostics) {
			awaitingDiagnostics.set(documentKey(uri), performance.now());
		}
	}

	function published(uri: string): void {
		if (awaitingDiagnostics.delete(documentKey(uri))) {
			settle();
		}
	}

	/** The server has answered everything it owed: the idle period starts now. */
	function settle(): void {
		if (0 === outstanding.size && 0 === awaitingDiagnostics.size) {
			lastActivity = performance.now();
		}
	}

	/** Keeps the server's set of open documents, as the server sees them, for a replay after a restart. */
	function record(message: Message): void {
		if (isMethod(message, 'textDocument/didOpen')) {
			const { uri, languageId, version, text } = message.params.textDocument;
			documents.set(uri, { languageId, version, text });
		} else if (isMethod(message, 'textDocument/didChange')) {
			const document = documents.get(message.params.textDocument.uri);
			if (undefined !== document) {
				document.version = message.params.textDocument.version;
				document.text = fullText(message.params.contentChanges);
			}
		} else if (isMethod(message, 'textDocument/didClose')) {
			documents.delete(message.params.textDocument.uri);
		}
	}

	function armIdleTimer(delay: number): void {
		if (0 === idleMs || null === initializeParams) {
			return;
		}
		clearTimer(idleTimer);
		idleTimer = setTimeout(checkIdle, Math.min(Math.max(delay, 0), MAX_TIMER_MS));
		idleTimer.unref();
	}

	function checkIdle(): void {
		idleTimer = null;
		if ('running' !== state || null === child) {
			return;
		}
		const now = performance.now();
		// An answer that never came is no activity: dropping it leaves the idle clock where it was.
		for (const [id, sentAt] of outstanding) {
			if (now - sentAt > ABANDONED_MS) {
				outstanding.delete(id);
			}
		}
		for (const [key, changedAt] of awaitingDiagnostics) {
			if (now - changedAt > ABANDONED_MS) {
				awaitingDiagnostics.delete(key);
			}
		}
		if (outstanding.size > 0 || awaitingDiagnostics.size > 0) {
			armIdleTimer(idleMs);
			return;
		}
		const quiet = now - lastActivity;
		if (quiet < idleMs) {
			armIdleTimer(idleMs - quiet);
			return;
		}
		stop(child);
	}

	/** Stops the server the way a client does: shutdown, exit, and a kill only if it does not go. */
	function stop(server: ServerProcess): void {
		log(`no activity for ${formatDuration(idleMs)}; stopping the server to free its memory`);
		state = 'stopping';
		pendingShutdown = lifecycleId();
		writeMessage(server.stdin, { jsonrpc: '2.0', id: pendingShutdown, method: 'shutdown' });
		graceTimer = setTimeout(sendExit, GRACE_MS);
	}

	function sendExit(): void {
		pendingShutdown = null;
		clearTimer(graceTimer);
		const server = child;
		if ('stopping' !== state || null === server) {
			return;
		}
		writeMessage(server.stdin, { jsonrpc: '2.0', method: 'exit' });
		server.stdin.end();
		graceTimer = setTimeout(() => {
			graceTimer = null;
			terminate(server);
		}, GRACE_MS);
	}

	/** Starts a server for a message that needs one, or remembers to once the stopping one is gone. */
	function wake(wanted: boolean): void {
		if (false === wanted || shutdownAnswered) {
			return;
		}
		if ('stopping' === state) {
			restartWanted = true;
		} else if ('stopped' === state) {
			restart();
		}
	}

	function restart(): void {
		restartWanted = false;
		if (null === initializeParams) {
			return;
		}
		log('starting the server again');
		state = 'starting';
		let next: ServerCommand;
		try {
			next = options.resolveServer();
		} catch (error) {
			restartFailed(error instanceof Error ? error.message : String(error));
			return;
		}
		if (next.native !== native) {
			log(`the project now needs ${next.native ? "TypeScript's own server" : 'typescript-language-server'}; ending so that Claude Code starts the launcher again`);
			finish(1);
			return;
		}
		if (next.command !== command || next.args.join(' ') !== args.join(' ')) {
			log(`the server moved: launching ${next.command} ${next.args.join(' ')}`);
			({ command, args } = next);
		}
		let server: ServerProcess;
		try {
			server = spawnServer();
		} catch (error) {
			restartFailed(error instanceof Error ? error.message : String(error));
			return;
		}
		child = server;
		startupTimer = setTimeout(() => restartFailed(`it did not answer initialize within ${formatDuration(STARTUP_TIMEOUT_MS)}`), STARTUP_TIMEOUT_MS);
		pendingInitialize = lifecycleId();
		writeMessage(server.stdin, methodMessage('initialize', initializeParams, pendingInitialize));
	}

	/** Brings the new server to where the old one was, then lets the queued messages through. */
	function initialized(response: Message): void {
		const server = child;
		if ('starting' !== state || null === server) {
			return;
		}
		clearTimer(startupTimer);
		startupTimer = null;
		if (undefined !== response.error) {
			restartFailed(`it rejected initialize: ${response.error.message}`);
			return;
		}
		writeMessage(server.stdin, { jsonrpc: '2.0', method: 'initialized', params: {} });
		if (null !== configuration) {
			writeMessage(server.stdin, configuration);
		}
		for (const [uri, { languageId, version, text }] of documents) {
			writeMessage(server.stdin, methodMessage('textDocument/didOpen', { textDocument: { uri, languageId, version, text: text ?? readText(uri) } }));
			awaitDiagnostics(uri);
		}
		trace(`reopened ${documents.size} document(s)`);
		state = 'running';
		lastActivity = performance.now();
		options.onRestart();
		for (const { message, frame } of queue.splice(0)) {
			write(server, message, frame);
		}
		armIdleTimer(idleMs);
	}

	/** Goes back to stopped after a failed restart; queued requests are failed in a way Claude Code retries. */
	function restartFailed(reason: string): void {
		log(`could not start the server again: ${reason}`);
		const server = child;
		child = null;
		pendingInitialize = null;
		clearTimer(startupTimer);
		startupTimer = null;
		state = 'stopped';
		if (null !== server) {
			terminate(server);
		}
		drainQueue({ code: CONTENT_MODIFIED, message: 'the language server could not be started again; retry' });
	}

	function answerShutdown(id: RequestId): void {
		shutdownAnswered = true;
		restartWanted = false;
		drainQueue({ code: REQUEST_CANCELLED, message: 'the session is shutting down' });
		writeMessage(output, { jsonrpc: '2.0', id, result: null });
	}

	/**
	 * Settles the queue without a server, in order: document changes go into the
	 * record for the next server, requests get `error` (the proxy's own through its
	 * features, so they can react), a queued shutdown or exit is handled as if no
	 * server had been needed, and other notifications are dropped.
	 */
	function drainQueue(error: { code: number; message: string }): void {
		for (const { message } of queue.splice(0)) {
			if (isDocumentNotification(message)) {
				record(message);
			} else if ('shutdown' === message.method && isRequest(message)) {
				shutdownAnswered = true;
				restartWanted = false;
				writeMessage(output, { jsonrpc: '2.0', id: message.id, result: null });
			} else if ('exit' === message.method) {
				clientEnded();
			} else if (isRequest(message)) {
				const response: Message = { jsonrpc: '2.0', id: message.id, error };
				if ('string' === typeof message.id && message.id.startsWith(ID_PREFIX)) {
					options.onOwnResponse(response);
				} else {
					writeMessage(output, response);
				}
			}
		}
	}

	function clientEnded(): void {
		ending ??= 'exit';
		if ('stopped' === state) {
			finish(0);
		}
	}

	/** Ends the session. A server still running is stopped too, so it never outlives the proxy. */
	function finish(code: number): void {
		clearTimers();
		options.onExit(code);
		if (null !== child) {
			terminate(child);
		}
	}

	function clearTimers(): void {
		clearTimer(idleTimer);
		clearTimer(graceTimer);
		clearTimer(startupTimer);
		idleTimer = null;
		graceTimer = null;
		startupTimer = null;
	}

	function lifecycleId(): string {
		return `${LIFECYCLE_PREFIX}${++nextId}`;
	}
}

/**
 * Ends a process with `signal`, then kills it outright if it is still running
 * after a grace period. Windows has no POSIX signals and Node refuses most signal
 * names there, so the process is simply terminated.
 */
export function terminate(server: Pick<ChildProcess, 'kill' | 'exitCode' | 'signalCode'>, signal: NodeJS.Signals = 'SIGTERM'): void {
	if (null !== server.exitCode || null !== server.signalCode) {
		return;
	}
	if ('win32' === process.platform) {
		server.kill();
		return;
	}
	server.kill(signal);
	setTimeout(() => {
		if (null === server.exitCode && null === server.signalCode) {
			server.kill('SIGKILL');
		}
	}, GRACE_MS).unref();
}

/** The exit status a process should report for a child that ended with `code` or `signal`. */
export function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
	if (null !== signal) {
		return 128 + (os.constants.signals[signal] ?? 0);
	}
	return code ?? 1;
}

function isRequest(message: Message): message is Message & { id: RequestId; method: string } {
	return undefined !== message.method && undefined !== message.id && null !== message.id;
}

function isDocumentNotification(message: Message): boolean {
	return 'textDocument/didOpen' === message.method || 'textDocument/didChange' === message.method || 'textDocument/didClose' === message.method;
}

/** The document's new content when the change replaces it entirely, as Claude Code's always do; null for incremental edits. */
function fullText(contentChanges: TextDocumentContentChangeEvent[]): string | null {
	const last = contentChanges.at(-1);
	return undefined !== last && false === 'range' in last ? last.text : null;
}

/** Identifies a document across the spellings client and server may use for its URI (percent-encoding, drive-letter case). */
function documentKey(uri: string): string {
	try {
		const file = fileURLToPath(uri);
		return 'win32' === process.platform ? file.toLowerCase() : file;
	} catch {
		return uri;
	}
}

function readText(uri: string): string {
	try {
		return fs.readFileSync(fileURLToPath(uri), 'utf8');
	} catch {
		return '';
	}
}

function clearTimer(timer: NodeJS.Timeout | null): void {
	if (null !== timer) {
		clearTimeout(timer);
	}
}

function formatDuration(ms: number): string {
	return ms >= 60_000 && 0 === ms % 60_000 ? `${ms / 60_000} min` : `${Number((ms / 1000).toFixed(3))} s`;
}
