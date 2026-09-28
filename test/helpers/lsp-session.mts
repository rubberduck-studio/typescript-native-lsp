import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ClientCapabilities, PublishDiagnosticsParams } from 'vscode-languageserver-protocol';
import type { Message, MethodMessage } from '../../scripts/proxy.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, '..', '..', 'scripts', 'launch.mjs');

interface ClaudeCodeClient {
	clientInfo: { name: string; version: string };
	initializationOptions: unknown;
	capabilities: ClientCapabilities;
}

/** What Claude Code itself sends in `initialize`, so sessions here behave like the real client. */
export const claudeCodeClient: ClaudeCodeClient = loadClaudeCodeClient();

export type Diagnostics = MethodMessage<'textDocument/publishDiagnostics'>;

export interface Exit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

interface Waiter {
	predicate(message: Message): boolean;
	resolve(message: Message): void;
	reject(error: Error): void;
}

export interface SessionOptions {
	env?: NodeJS.ProcessEnv;
	capabilities?: ClientCapabilities;
}

export interface Session {
	child: ChildProcessWithoutNullStreams;
	/** Every notification the server sent, in order. */
	notifications: Message[];
	/** Responses whose id this session never sent; a proxy must never leak its own. */
	unexpectedResponses: Message[];
	readonly stderr: string;
	request(method: string, params?: unknown): Promise<Message>;
	notify(method: string, params?: unknown): void;
	/** Resolves with the first notification (past or future) matching the predicate, or rejects after the timeout. */
	waitForNotification<T extends Message>(predicate: (message: Message) => message is T, options?: { timeoutMs?: number }): Promise<T>;
	waitForNotification(predicate: (message: Message) => boolean, options?: { timeoutMs?: number }): Promise<Message>;
	/** Resolves true if a matching notification arrives within the window, false otherwise. */
	receivesNotification(predicate: (message: Message) => boolean, options?: { withinMs?: number }): Promise<boolean>;
	initialize(): Promise<Message>;
	openFile(filePath: string, text?: string): void;
	changeFile(filePath: string, version: number, text: string): void;
	/** Resolves once the launcher process has exited, with its exit code and signal. */
	exited(): Promise<Exit>;
	/** Ends the session the way a client does: close stdin, give the launcher time to exit with its server, kill only if it does not. */
	close(): Promise<void>;
}

/**
 * Starts the launcher for a project directory as an LSP client would, and
 * exposes just enough of the protocol for behavioural tests: requests with
 * awaited responses, fire-and-forget notifications, a log of everything the
 * server sent, and a way to wait for a notification matching a predicate.
 * Server-to-client requests are answered with null, as Claude Code does.
 */
export function startSession(projectDir: string, { env = {}, capabilities = claudeCodeClient.capabilities }: SessionOptions = {}): Session {
	const child = spawn(process.execPath, [launcher], {
		cwd: projectDir,
		env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: projectDir, TYPESCRIPT_NATIVE_LSP_GLOBAL_ROOTS: '', ...env },
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	child.stdin.on('error', () => {});
	let buffer = Buffer.alloc(0);
	let stderr = '';
	let nextId = 0;
	const pending = new Map<number, (message: Message) => void>();
	const notifications: Message[] = [];
	const unexpectedResponses: Message[] = [];
	const waiters: Waiter[] = [];

	child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
	child.on('exit', (code, signal) => {
		const reason = new Error(`launcher exited (code ${code}, signal ${signal}) before answering\nstderr:\n${stderr}`);
		for (const resolve of pending.values()) {
			resolve({ jsonrpc: '2.0', error: { code: -32099, message: reason.message } });
		}
		pending.clear();
		for (const waiter of waiters.splice(0)) {
			waiter.reject(reason);
		}
	});
	child.stdout.on('data', (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (let message = readMessage(); null !== message; message = readMessage()) {
			dispatch(message);
		}
	});

	function readMessage(): Message | null {
		const headerEnd = buffer.indexOf('\r\n\r\n');
		if (-1 === headerEnd) {
			return null;
		}
		const declared = /Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1];
		if (undefined === declared) {
			throw new Error('frame without Content-Length');
		}
		const length = Number.parseInt(declared, 10);
		const bodyStart = headerEnd + 4;
		if (buffer.length < bodyStart + length) {
			return null;
		}
		const parsed: unknown = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString('utf8'));
		buffer = buffer.subarray(bodyStart + length);
		if (false === isMessage(parsed)) {
			throw new Error('not a JSON-RPC message');
		}
		return parsed;
	}

	function dispatch(message: Message): void {
		if (undefined !== message.method && undefined !== message.id) {
			write({ jsonrpc: '2.0', id: message.id, result: null });
			return;
		}
		if (undefined !== message.method) {
			notifications.push(message);
			for (const waiter of [...waiters]) {
				if (waiter.predicate(message)) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve(message);
				}
			}
			return;
		}
		const resolve = 'number' === typeof message.id ? pending.get(message.id) : undefined;
		if (undefined === resolve || 'number' !== typeof message.id) {
			unexpectedResponses.push(message);
			return;
		}
		pending.delete(message.id);
		resolve(message);
	}

	function write(message: Message): void {
		const body = JSON.stringify(message);
		child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}

	function waitForNotification(predicate: (message: Message) => boolean, { timeoutMs = 15000 }: { timeoutMs?: number } = {}): Promise<Message> {
		const seen = notifications.find(predicate);
		if (undefined !== seen) {
			return Promise.resolve(seen);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				waiters.splice(waiters.indexOf(waiter), 1);
				reject(new Error(`no matching notification within ${timeoutMs}ms\nstderr:\n${stderr}\nnotifications: ${notifications.map(n => n.method).join(', ')}`));
			}, timeoutMs);
			const waiter: Waiter = {
				predicate,
				resolve: message => {
					clearTimeout(timer);
					resolve(message);
				},
				reject: error => {
					clearTimeout(timer);
					reject(error);
				},
			};
			waiters.push(waiter);
		});
	}

	const session: Session = {
		child,
		notifications,
		unexpectedResponses,
		get stderr() {
			return stderr;
		},
		request(method, params) {
			return new Promise(resolve => {
				const id = ++nextId;
				pending.set(id, resolve);
				write(undefined === params ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
			});
		},
		notify(method, params) {
			write(undefined === params ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
		},
		waitForNotification,
		async receivesNotification(predicate, { withinMs = 2000 } = {}) {
			try {
				await waitForNotification(predicate, { timeoutMs: withinMs });
				return true;
			} catch {
				return false;
			}
		},
		async initialize() {
			const response = await session.request('initialize', {
				processId: process.pid,
				clientInfo: claudeCodeClient.clientInfo,
				initializationOptions: claudeCodeClient.initializationOptions,
				rootUri: pathToFileURL(projectDir).href,
				rootPath: projectDir,
				workspaceFolders: [{ uri: pathToFileURL(projectDir).href, name: path.basename(projectDir) }],
				capabilities,
			});
			session.notify('initialized', {});
			return response;
		},
		openFile(filePath, text = fs.readFileSync(filePath, 'utf8')) {
			session.notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(filePath).href, languageId: 'typescript', version: 1, text } });
		},
		changeFile(filePath, version, text) {
			session.notify('textDocument/didChange', { textDocument: { uri: pathToFileURL(filePath).href, version }, contentChanges: [{ text }] });
		},
		exited() {
			return new Promise(resolve => {
				if (null !== child.exitCode || null !== child.signalCode) {
					resolve({ code: child.exitCode, signal: child.signalCode });
					return;
				}
				child.once('exit', (code, signal) => resolve({ code, signal }));
			});
		},
		async close() {
			child.stdin.end();
			const timer = setTimeout(() => child.kill(), 3000);
			await session.exited();
			clearTimeout(timer);
		},
	};
	return session;
}

export function uriOf(filePath: string): string {
	return pathToFileURL(filePath).href;
}

/** True when two file URIs name the same file, regardless of percent-encoding or drive-letter case. */
export function sameFile(uriA: string, uriB: string): boolean {
	try {
		return fileURLToPath(uriA).toLowerCase() === fileURLToPath(uriB).toLowerCase();
	} catch {
		return false;
	}
}

/** Matches publishDiagnostics notifications for one file. */
export function diagnosticsFor(filePath: string): (message: Message) => message is Diagnostics {
	return (message): message is Diagnostics => 'textDocument/publishDiagnostics' === message.method && isPublishParams(message.params) && sameFile(message.params.uri, uriOf(filePath));
}

/** A notification as publishDiagnostics, or null when it is something else. */
export function asDiagnostics(message: Message): Diagnostics | null {
	return 'textDocument/publishDiagnostics' === message.method && isPublishParams(message.params) ? { ...message, method: 'textDocument/publishDiagnostics', params: message.params } : null;
}

function isPublishParams(value: unknown): value is PublishDiagnosticsParams {
	return 'object' === typeof value && null !== value && 'uri' in value && 'string' === typeof value.uri && 'diagnostics' in value && Array.isArray(value.diagnostics);
}

function isMessage(value: unknown): value is Message {
	return 'object' === typeof value && null !== value && 'jsonrpc' in value;
}

function loadClaudeCodeClient(): ClaudeCodeClient {
	const parsed: unknown = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'claude-code-client.json'), 'utf8'));
	if ('object' !== typeof parsed || null === parsed || false === 'capabilities' in parsed || false === 'clientInfo' in parsed) {
		throw new Error('test/fixtures/claude-code-client.json is not a captured initialize payload');
	}
	const { clientInfo, capabilities } = parsed;
	if (false === isClientInfo(clientInfo) || 'object' !== typeof capabilities || null === capabilities) {
		throw new Error('test/fixtures/claude-code-client.json has an unexpected shape');
	}
	return { clientInfo, initializationOptions: 'initializationOptions' in parsed ? parsed.initializationOptions : undefined, capabilities };
}

function isClientInfo(value: unknown): value is ClaudeCodeClient['clientInfo'] {
	return 'object' === typeof value && null !== value && 'name' in value && 'string' === typeof value.name && 'version' in value && 'string' === typeof value.version;
}

/** The parent environment without any of this plugin's own switches, so a developer's shell cannot steer a test. */
function cleanEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith('TYPESCRIPT_NATIVE_LSP_')) {
			delete env[key];
		}
	}
	return env;
}
