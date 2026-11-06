/**
 * The proxy's handling of the server process at its edges: restarts that fail
 * or hang, servers that do not stop, crashes, signals and protocol errors. Run
 * against the fake server, which can be made to misbehave on demand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startSession, uriOf, type Session } from './helpers/lsp-session.mts';
import { fakeServerProject } from './helpers/project.mts';

const IDLE = { TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS: '1', TYPESCRIPT_NATIVE_LSP_DEBUG: '1' };
const posixOnly = 'win32' === process.platform && 'POSIX signals and executables';

interface FakeState {
	pid: number;
	open: Record<string, number>;
	config: unknown;
}

/** What the fake server reports in its hover answer: its pid, its open documents with their versions, and its last configuration. */
async function fakeState(session: Session, file: string): Promise<FakeState> {
	const response = await session.request('textDocument/hover', { textDocument: { uri: uriOf(file) }, position: { line: 0, character: 0 } });
	assert.equal(response.error, undefined, JSON.stringify(response));
	const value = JSON.stringify(response.result);
	const match = /fake server (\d+) (\{.*\})"/.exec(value.replaceAll('\\"', '"'));
	assert.ok(null !== match, value);
	const state: unknown = JSON.parse(match[2] ?? '{}');
	assert.ok('object' === typeof state && null !== state && 'open' in state && 'config' in state, value);
	return { pid: Number(match[1]), open: { ...(state.open as Record<string, number>) }, config: state.config };
}

function hoverOf(session: Session, file: string): Promise<{ result?: unknown; error?: { code: number } }> {
	return session.request('textDocument/hover', { textDocument: { uri: uriOf(file) }, position: { line: 0, character: 0 } });
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test('a failed restart keeps the edits queued behind it for the next server, and fails the proxy\'s own requests internally', async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const failFile = path.join(root, 'fail');
	const other = path.join(root, 'b.ts');
	fs.writeFileSync(other, 'export const b = 1;\n');
	const session = startSession(root, { env: { ...env, ...IDLE, FAKE_FAIL_FILE: failFile, FAKE_FAIL_DELAY_MS: '500' } });
	try {
		await session.initialize();
		session.openFile(file);
		await fakeState(session, file);
		await session.waitForLog('server stopped');
		fs.writeFileSync(failFile, '');
		const failed = hoverOf(session, file);
		session.openFile(other);
		session.changeFile(file, 2, 'export const a = 2;\n');
		assert.equal((await failed).error?.code, -32801);
		fs.rmSync(failFile);
		const state = await fakeState(session, file);
		assert.ok(pathToFileURL(other).href in state.open, `the new server does not have b.ts open: ${JSON.stringify(state.open)}`);
		assert.ok(Object.values(state.open).length === 2, JSON.stringify(state.open));
		assert.deepEqual(session.unexpectedResponses, []);
	} finally {
		await session.close();
	}
});

test('a restarted server that never answers initialize is given up on, and a later request starts another', { timeout: 120000 }, async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const hangFile = path.join(root, 'hang');
	const session = startSession(root, { env: { ...env, ...IDLE, FAKE_HANG_FILE: hangFile } });
	try {
		await session.initialize();
		session.openFile(file);
		await fakeState(session, file);
		await session.waitForLog('server stopped');
		fs.writeFileSync(hangFile, '');
		// Longer than the helper waits for a response; the proxy answers it after its startup deadline.
		void hoverOf(session, file).catch(() => {});
		await session.waitForLog('did not answer initialize', { timeoutMs: 75000 });
		fs.rmSync(hangFile);
		assert.equal((await hoverOf(session, file)).error, undefined);
	} finally {
		await session.close();
	}
});

test('a native binary that cannot be run on restart fails the request, and the next one tries again', { skip: posixOnly }, async () => {
	const { root, file, server, env } = fakeServerProject('fake-server.mjs', { binary: true });
	const session = startSession(root, { env: { ...env, ...IDLE } });
	try {
		await session.initialize();
		session.openFile(file);
		await fakeState(session, file);
		await session.waitForLog('server stopped');
		fs.chmodSync(server, 0o644);
		const failed = await hoverOf(session, file);
		assert.equal(failed.error?.code, -32801, JSON.stringify(failed));
		assert.equal(session.child.exitCode, null, 'the launcher must survive a failed restart');
		fs.chmodSync(server, 0o755);
		assert.equal((await hoverOf(session, file)).error, undefined);
	} finally {
		await session.close();
	}
});

test('a server that ignores shutdown and exit is still stopped when idle, and a new one answers', async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env: { ...env, ...IDLE, FAKE_IGNORE_SHUTDOWN: '1', FAKE_IGNORE_EXIT: '1', FAKE_IGNORE_SIGTERM: '1' } });
	try {
		await session.initialize();
		session.openFile(file);
		const before = await fakeState(session, file);
		await session.waitForLog('server stopped', { timeoutMs: 15000 });
		assert.equal(isAlive(before.pid), false, 'the old server is still running');
		const after = await fakeState(session, file);
		assert.notEqual(after.pid, before.pid);
	} finally {
		await session.close();
	}
});

test('a server that ignores the end of its input is ended when the client goes away', async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env: { ...env, FAKE_IGNORE_EXIT: '1' } });
	try {
		await session.initialize();
		session.openFile(file);
		const { pid } = await fakeState(session, file);
		session.child.stdin.end();
		await session.exited({ timeoutMs: 10000 });
		assert.equal(isAlive(pid), false, 'the server outlived the launcher');
	} finally {
		await session.close();
	}
});

test('a server that crashes ends the launcher with its exit status', async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env });
	await session.initialize();
	session.openFile(file);
	await fakeState(session, file);
	void session.request('fake/exit', { code: 3 }).catch(() => {});
	assert.deepEqual(await session.exited(), { code: 3, signal: null });
});

test('a termination signal while the server is stopped ends the launcher with the signal\'s status', { skip: posixOnly }, async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env: { ...env, ...IDLE } });
	await session.initialize();
	session.openFile(file);
	await fakeState(session, file);
	await session.waitForLog('server stopped');
	session.child.kill('SIGTERM');
	const { code, signal } = await session.exited();
	assert.ok(143 === code || 'SIGTERM' === signal, `code ${code} signal ${signal}`);
});

test('a termination signal ends the server too', { skip: posixOnly }, async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env });
	await session.initialize();
	session.openFile(file);
	const { pid } = await fakeState(session, file);
	session.child.kill('SIGTERM');
	await session.exited();
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.equal(isAlive(pid), false, 'the server outlived the launcher');
});

test('a frame without Content-Length from the client ends the launcher with status 1', async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env });
	await session.initialize();
	session.openFile(file);
	const { pid } = await fakeState(session, file);
	session.child.stdin.write('Content-Type: text/plain\r\n\r\n{}');
	assert.equal((await session.exited()).code, 1);
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.equal(isAlive(pid), false, 'the server outlived the launcher');
});

test('a restarted server gets the last configuration the client sent', async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env: { ...env, ...IDLE } });
	try {
		await session.initialize();
		session.notify('workspace/didChangeConfiguration', { settings: { answer: 42 } });
		session.openFile(file);
		assert.deepEqual((await fakeState(session, file)).config, { answer: 42 });
		await session.waitForLog('server stopped');
		assert.deepEqual((await fakeState(session, file)).config, { answer: 42 });
	} finally {
		await session.close();
	}
});

test('a shutdown while the server is stopped starts no server, even when an open file changed on disk', async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env: { ...env, ...IDLE } });
	try {
		await session.initialize();
		session.openFile(file);
		await fakeState(session, file);
		await session.waitForLog('server stopped');
		fs.writeFileSync(file, 'export const a = 2;\n');
		const response = await session.request('shutdown');
		assert.equal(response.result, null);
		session.notify('exit');
		assert.deepEqual(await session.exited(), { code: 0, signal: null });
		assert.doesNotMatch(session.stderr, /starting the server again/);
	} finally {
		await session.close();
	}
});

test('a restart starts the server from where it is now, when it moved while stopped', { skip: posixOnly }, async () => {
	const { root, file, server, env } = fakeServerProject('fake-server.mjs', { binary: true });
	const session = startSession(root, { env: { ...env, ...IDLE } });
	try {
		await session.initialize();
		session.openFile(file);
		await fakeState(session, file);
		await session.waitForLog('server stopped');
		fs.rmSync(path.dirname(path.dirname(server)), { recursive: true });
		assert.equal((await hoverOf(session, file)).error, undefined);
		assert.match(session.stderr, /the server moved: launching .*tsc\.js/);
	} finally {
		await session.close();
	}
});

test('a project that switched to TypeScript 6 while the server was stopped ends the launcher, so Claude Code starts it again', { skip: false === fs.existsSync(path.join(import.meta.dirname, 'fixtures', 'ts6', 'node_modules')) && 'run npm run fixtures' }, async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env: { ...env, ...IDLE } });
	await session.initialize();
	session.openFile(file);
	await fakeState(session, file);
	await session.waitForLog('server stopped');
	fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
	fs.symlinkSync(path.join(import.meta.dirname, 'fixtures', 'ts6', 'node_modules'), path.join(root, 'node_modules'), 'junction');
	void hoverOf(session, file).catch(() => {});
	const { code } = await session.exited();
	assert.equal(code, 1);
	assert.match(session.stderr, /now needs typescript-language-server/);
});
