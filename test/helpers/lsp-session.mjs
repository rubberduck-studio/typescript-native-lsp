import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, '..', '..', 'scripts', 'launch.mjs');

/** What Claude Code itself sends in `initialize`, so sessions here behave like the real client. */
export const claudeCodeClient = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'claude-code-client.json'), 'utf8'));

/**
 * Starts the launcher for a project directory as an LSP client would, and
 * exposes just enough of the protocol for behavioural tests: requests with
 * awaited responses, fire-and-forget notifications, a log of everything the
 * server sent, and a way to wait for a notification matching a predicate.
 * Server-to-client requests are answered with null, as Claude Code does.
 */
export function startSession(projectDir, { env = {}, capabilities = claudeCodeClient.capabilities } = {}) {
	const child = spawn(process.execPath, [launcher], {
		cwd: projectDir,
		env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: projectDir, TYPESCRIPT_NATIVE_LSP_GLOBAL_ROOTS: '', ...env },
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	child.stdin.on('error', () => {});
	let buffer = Buffer.alloc(0);
	let stderr = '';
	let nextId = 0;
	const pending = new Map();
	const notifications = [];
	const waiters = [];

	child.stderr.on('data', chunk => (stderr += chunk));
	child.on('exit', (code, signal) => {
		const reason = new Error(`launcher exited (code ${code}, signal ${signal}) before answering\nstderr:\n${stderr}`);
		for (const resolve of pending.values()) {
			resolve({ error: { message: reason.message } });
		}
		pending.clear();
		for (const waiter of waiters.splice(0)) {
			waiter.reject(reason);
		}
	});
	child.stdout.on('data', chunk => {
		buffer = Buffer.concat([buffer, chunk]);
		for (let message = readMessage(); null !== message; message = readMessage()) {
			dispatch(message);
		}
	});

	function readMessage() {
		const headerEnd = buffer.indexOf('\r\n\r\n');
		if (-1 === headerEnd) {
			return null;
		}
		const length = Number.parseInt(/Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString('ascii'))[1], 10);
		const bodyStart = headerEnd + 4;
		if (buffer.length < bodyStart + length) {
			return null;
		}
		const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString('utf8'));
		buffer = buffer.subarray(bodyStart + length);
		return message;
	}

	function dispatch(message) {
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
		const resolve = pending.get(message.id);
		pending.delete(message.id);
		resolve?.(message);
	}

	function write(message) {
		const body = JSON.stringify(message);
		child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}

	const session = {
		child,
		notifications,
		get stderr() {
			return stderr;
		},
		request(method, params) {
			return new Promise(resolve => {
				const id = ++nextId;
				pending.set(id, resolve);
				write({ jsonrpc: '2.0', id, method, params });
			});
		},
		notify(method, params) {
			write({ jsonrpc: '2.0', method, params });
		},
		/** Resolves with the first notification (past or future) matching the predicate, or rejects after the timeout. */
		waitForNotification(predicate, { timeoutMs = 15000 } = {}) {
			const seen = notifications.find(predicate);
			if (undefined !== seen) {
				return Promise.resolve(seen);
			}
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					waiters.splice(waiters.indexOf(waiter), 1);
					reject(new Error(`no matching notification within ${timeoutMs}ms\nstderr:\n${stderr}\nnotifications: ${notifications.map(n => n.method).join(', ')}`));
				}, timeoutMs);
				const waiter = {
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
		},
		/** Resolves true if a matching notification arrives within the window, false otherwise. */
		async receivesNotification(predicate, { withinMs = 2000 } = {}) {
			try {
				await session.waitForNotification(predicate, { timeoutMs: withinMs });
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
		/** Resolves once the launcher process has exited, with its exit code and signal. */
		exited() {
			return new Promise(resolve => {
				if (null !== child.exitCode || null !== child.signalCode) {
					resolve({ code: child.exitCode, signal: child.signalCode });
					return;
				}
				child.once('exit', (code, signal) => resolve({ code, signal }));
			});
		},
		close() {
			child.stdin.end();
			child.kill();
		},
	};
	return session;
}

export function uriOf(filePath) {
	return pathToFileURL(filePath).href;
}

/** True when two file URIs name the same file, regardless of percent-encoding or drive-letter case. */
export function sameFile(uriA, uriB) {
	try {
		return fileURLToPath(uriA).toLowerCase() === fileURLToPath(uriB).toLowerCase();
	} catch {
		return false;
	}
}

/** Matches publishDiagnostics notifications for one file. */
export function diagnosticsFor(filePath) {
	return message => 'textDocument/publishDiagnostics' === message.method && sameFile(message.params.uri, uriOf(filePath));
}

/** The parent environment without any of this plugin's own switches, so a developer's shell cannot steer a test. */
function cleanEnv() {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith('TYPESCRIPT_NATIVE_LSP_')) {
			delete env[key];
		}
	}
	return env;
}
