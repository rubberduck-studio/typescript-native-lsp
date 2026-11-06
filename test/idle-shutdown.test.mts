/**
 * Behavioural contract for idle shutdown: once the client has been quiet for the
 * idle period and nothing waits for an answer, the server process goes away to
 * free its memory, the launcher stays, and the client notices nothing beyond the
 * next request taking as long as a cold start. Answers after the restart must
 * reflect everything the client had told the old server.
 *
 * Every session runs with TYPESCRIPT_NATIVE_LSP_DEBUG=1, so the launcher logs
 * "server stopped" once the old server process has exited.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Location, LocationLink } from 'vscode-languageserver-protocol';
import { startSession, diagnosticsFor, hoverText, uriOf, type Diagnostics, type Session } from './helpers/lsp-session.mts';
import { fakeServerProject, missingFixture, tempProject, writeSource, sourcePath } from './helpers/project.mts';

const DEBUG = { TYPESCRIPT_NATIVE_LSP_DEBUG: '1' };
const IDLE = { ...DEBUG, TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS: '1' };
const STOPPING = 'stopping the server to free its memory';
const STOPPED = 'server stopped';
const RESTARTING = 'starting the server again';

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** Waits until the launcher has stopped its idle server `count` times in total, and checks that it is still running itself. */
async function waitForIdleStop(session: Session, count = 1): Promise<void> {
	await session.waitForLog(STOPPED, { count });
	assert.equal(session.child.exitCode, null, 'the launcher must outlive its server');
}

function hoverAt(session: Session, file: string): Promise<{ result?: unknown; error?: { code: number } }> {
	return session.request('textDocument/hover', { textDocument: { uri: uriOf(file) }, position: { line: 0, character: 13 } });
}

function countOf(text: string, session: Session): number {
	return session.stderr.split(text).length - 1;
}

for (const engine of ['ts7', 'ts6']) {
	const skip = missingFixture(engine);

	test(`${engine}: an idle server is stopped while the launcher stays, answers the next request as a new server, and is stopped again`, { skip }, async () => {
		const root = tempProject(engine, { 'a.ts': 'export const a = 1;\n' });
		const file = sourcePath(root, 'a.ts');
		const session = startSession(root, { env: IDLE });
		try {
			await session.initialize();
			session.openFile(file);
			assert.match(await hoverText(session, file, 0, 13), /a: 1/);
			await waitForIdleStop(session);
			assert.match(await hoverText(session, file, 0, 13), /a: 1/);
			assert.equal(countOf(RESTARTING, session), 1, session.stderr);
			await waitForIdleStop(session, 2);
			assert.deepEqual(session.unexpectedResponses, []);
		} finally {
			await session.close();
		}
	});

	test(`${engine}: edits while the server is stopped reach the new one, with diagnostics`, { skip }, async () => {
		const root = tempProject(engine, { 'a.ts': 'export const a = 1;\n' });
		const file = sourcePath(root, 'a.ts');
		const session = startSession(root, { env: IDLE });
		try {
			await session.initialize();
			session.openFile(file);
			assert.match(await hoverText(session, file, 0, 13), /a: 1/);
			await waitForIdleStop(session);
			const broken = 'export const a: string = 2;\n';
			writeSource(root, 'a.ts', broken);
			session.changeFile(file, 2, broken);
			const published = await session.waitForNotification((message): message is Diagnostics => diagnosticsFor(file)(message) && message.params.diagnostics.some(d => 2322 === d.code));
			if ('ts7' === engine) {
				assert.equal(published.params.version, 2);
			}
			const fixed = 'export const a = "x";\n';
			writeSource(root, 'a.ts', fixed);
			session.changeFile(file, 3, fixed);
			assert.match(await hoverText(session, file, 0, 13), /a: "x"/);
			assert.equal(session.child.exitCode, null);
		} finally {
			await session.close();
		}
	});

	test(`${engine}: the new server gets the client's text of an open document, not the file on disk`, { skip }, async () => {
		const root = tempProject(engine, { 'a.ts': 'export const a = 1;\n' });
		const file = sourcePath(root, 'a.ts');
		const session = startSession(root, { env: { ...IDLE, TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC: '0' } });
		try {
			await session.initialize();
			session.openFile(file, 'export const a = 2;\n');
			assert.match(await hoverText(session, file, 0, 13), /a: 2/);
			await waitForIdleStop(session);
			assert.match(await hoverText(session, file, 0, 13), /a: 2/);
		} finally {
			await session.close();
		}
	});
}

test('client activity keeps the server running', { skip: missingFixture('ts7') }, async () => {
	const root = tempProject('ts7', { 'a.ts': 'export const a = 1;\n' });
	const file = sourcePath(root, 'a.ts');
	const session = startSession(root, { env: { ...DEBUG, TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS: '2' } });
	try {
		await session.initialize();
		session.openFile(file);
		for (let elapsed = 0; elapsed < 5000; elapsed += 500) {
			assert.match(await hoverText(session, file, 0, 13), /a: 1/);
			await sleep(500);
		}
		assert.equal(countOf(STOPPING, session), 0, session.stderr);
	} finally {
		await session.close();
	}
});

test('a request still being answered when the idle period ends is answered, and the server stops afterwards', async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env: { ...env, ...IDLE, FAKE_HOVER_DELAY_MS: '2500' } });
	try {
		await session.initialize();
		session.openFile(file);
		const response = await hoverAt(session, file);
		assert.equal(response.error, undefined);
		assert.match(JSON.stringify(response.result), /fake server/);
		await waitForIdleStop(session);
	} finally {
		await session.close();
	}
});

test('a request that arrives while the server is being stopped is answered by a new one', async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env: { ...env, ...IDLE, FAKE_SHUTDOWN_DELAY_MS: '1500' } });
	try {
		await session.initialize();
		session.openFile(file);
		const first = JSON.stringify((await hoverAt(session, file)).result);
		await session.waitForLog(STOPPING);
		assert.equal(countOf(STOPPED, session), 0, 'the stop must still be in progress');
		const second = await hoverAt(session, file);
		assert.equal(second.error, undefined);
		assert.notEqual(JSON.stringify(second.result), first, 'answered by the old server');
		assert.equal(countOf(RESTARTING, session), 1, session.stderr);
	} finally {
		await session.close();
	}
});

test('a client that shuts down while the server is being stopped gets no new server, and its queued request an error', async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env: { ...env, ...IDLE, FAKE_SHUTDOWN_DELAY_MS: '1500' } });
	try {
		await session.initialize();
		session.openFile(file);
		await hoverAt(session, file);
		await session.waitForLog(STOPPING);
		const queued = hoverAt(session, file);
		const shutdown = await session.request('shutdown');
		assert.equal(shutdown.result, null);
		assert.notEqual((await queued).error, undefined);
		await session.waitForLog(STOPPED);
		session.notify('exit');
		assert.deepEqual(await session.exited(), { code: 0, signal: null });
		assert.equal(countOf(RESTARTING, session), 0, session.stderr);
	} finally {
		await session.close();
	}
});

test('a client that ends the session while the server is stopped is answered without a restart, and the launcher exits 0', { skip: missingFixture('ts7') }, async () => {
	const root = tempProject('ts7', { 'a.ts': 'export const a = 1;\n' });
	const session = startSession(root, { env: IDLE });
	try {
		await session.initialize();
		session.openFile(sourcePath(root, 'a.ts'));
		await waitForIdleStop(session);
		const response = await session.request('shutdown');
		assert.equal(response.error, undefined);
		assert.equal(response.result, null);
		session.notify('exit');
		assert.deepEqual(await session.exited(), { code: 0, signal: null });
		assert.equal(countOf(RESTARTING, session), 0, session.stderr);
	} finally {
		await session.close();
	}
});

test('a server that cannot be started again fails the request with ContentModified and is retried on the next one', async () => {
	const { root, file, server, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env: { ...env, ...IDLE } });
	try {
		await session.initialize();
		session.openFile(file);
		await hoverAt(session, file);
		await waitForIdleStop(session);
		const saved = fs.readFileSync(server);
		fs.rmSync(server);
		const failed = await hoverAt(session, file);
		assert.equal(failed.error?.code, -32801, JSON.stringify(failed));
		assert.equal(session.child.exitCode, null, 'the launcher must survive a failed restart');
		fs.writeFileSync(server, saved);
		const answered = await hoverAt(session, file);
		assert.equal(answered.error, undefined, JSON.stringify(answered));
	} finally {
		await session.close();
	}
});

test('a server whose own child keeps its output open still counts as stopped once it exits', async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env: { ...env, ...IDLE, FAKE_PIPE_HOLDER_MS: '20000' } });
	try {
		await session.initialize();
		session.openFile(file);
		await hoverAt(session, file);
		await session.waitForLog(STOPPED, { timeoutMs: 10000 });
		const answered = await hoverAt(session, file);
		assert.equal(answered.error, undefined);
	} finally {
		await session.close();
	}
});

test('a file deleted and closed before the stop does not come back with the new server', { skip: missingFixture('ts7') }, async () => {
	const root = tempProject('ts7', { 'a.ts': 'export class Thing {}\n', 'b.ts': 'import { Thing } from "./a.js";\nexport const t = Thing;\n' });
	const a = sourcePath(root, 'a.ts');
	const b = sourcePath(root, 'b.ts');
	const session = startSession(root, { env: IDLE });
	try {
		await session.initialize();
		session.openFile(a);
		await hoverText(session, a, 0, 14);
		fs.rmSync(a);
		session.openFile(b);
		await hoverText(session, b, 1, 13);
		await waitForIdleStop(session);
		const { result } = await session.request('textDocument/definition', { textDocument: { uri: uriOf(b) }, position: { line: 1, character: 17 } });
		const targets = [result ?? []].flat().filter(isLocation).map(location => fileURLToPath('uri' in location ? location.uri : location.targetUri));
		assert.deepEqual(targets.filter(target => target.endsWith('a.ts')), [], 'definition points into the deleted file');
	} finally {
		await session.close();
	}
});

test('a request sent while the server is stopped is answered against the documents as they were when it was sent', { skip: missingFixture('ts7') }, async () => {
	const root = tempProject('ts7', { 'a.ts': 'export const a = 1;\n' });
	const file = sourcePath(root, 'a.ts');
	const session = startSession(root, { env: { ...IDLE, TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC: '0' } });
	try {
		await session.initialize();
		session.openFile(file);
		assert.match(await hoverText(session, file, 0, 13), /a: 1/);
		await waitForIdleStop(session);
		const hover = hoverText(session, file, 0, 13);
		session.changeFile(file, 2, 'export const a = "later";\n');
		assert.match(await hover, /a: 1/);
		assert.match(await hoverText(session, file, 0, 13), /a: "later"/);
	} finally {
		await session.close();
	}
});

test('server messages alone do not keep an idle server running', { skip: missingFixture('ts7') }, async () => {
	const root = tempProject('ts7', { 'a.ts': 'export const a = 1;\n' });
	const file = sourcePath(root, 'a.ts');
	const session = startSession(root, { env: IDLE });
	try {
		await session.initialize();
		session.openFile(file);
		assert.match(await hoverText(session, file, 0, 13), /a: 1/);
		const logMessages = (): number => session.notifications.filter(message => 'window/logMessage' === message.method).length;
		const before = logMessages();
		let edits = 0;
		const churn = setInterval(() => writeSource(root, `churn${++edits % 3}.ts`, `export const c = ${edits};\n`), 100);
		try {
			await waitForIdleStop(session);
		} finally {
			clearInterval(churn);
		}
		assert.ok(logMessages() > before, 'the server logged nothing while files changed, so this test proves nothing');
	} finally {
		await session.close();
	}
});

test('TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS=0 keeps the server running', { skip: missingFixture('ts7') }, async () => {
	const root = tempProject('ts7', { 'a.ts': 'export const a = 1;\n' });
	const file = sourcePath(root, 'a.ts');
	const session = startSession(root, { env: { ...DEBUG, TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS: '0' } });
	try {
		await session.initialize();
		session.openFile(file);
		assert.match(await hoverText(session, file, 0, 13), /a: 1/);
		await sleep(2500);
		assert.equal(countOf(STOPPING, session), 0, session.stderr);
		assert.match(await hoverText(session, file, 0, 13), /a: 1/);
		assert.equal(countOf(RESTARTING, session), 0, session.stderr);
	} finally {
		await session.close();
	}
});

test('an idle period longer than a timer can hold neither warns nor stops the server', { skip: missingFixture('ts7') }, async () => {
	const root = tempProject('ts7', { 'a.ts': 'export const a = 1;\n' });
	const file = sourcePath(root, 'a.ts');
	const session = startSession(root, { env: { ...DEBUG, TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS: '99999999' } });
	try {
		await session.initialize();
		session.openFile(file);
		assert.match(await hoverText(session, file, 0, 13), /a: 1/);
		await sleep(1500);
		assert.doesNotMatch(session.stderr, /TimeoutOverflowWarning/);
		assert.equal(countOf(STOPPING, session), 0, session.stderr);
	} finally {
		await session.close();
	}
});

function isLocation(value: unknown): value is Location | LocationLink {
	return 'object' === typeof value && null !== value && ('uri' in value || 'targetUri' in value);
}
