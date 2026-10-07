/**
 * Tests of the pull-to-push bridge's own switches, framing and edge cases.
 * Delete together with scripts/diagnostics-bridge.mjs and
 * test/helpers/fake-native-server.mjs; the behavioural contract lives in
 * diagnostics.test.mjs and must keep passing without the bridge.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSession, diagnosticsFor, claudeCodeClient, uriOf, type Diagnostics } from './helpers/lsp-session.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const ts7 = path.join(here, 'fixtures', 'ts7');
const skip = false === fs.existsSync(path.join(ts7, 'node_modules')) && 'run npm run fixtures';

const tempDirs: string[] = [];
after(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
});

/**
 * A project whose "TypeScript 7" is the fake server: the launcher finds a
 * typescript package without a platform binary and runs its lib/tsc.js with
 * node, which is exactly the fake. FAKE_PULLS scripts the server's answers.
 */
function fakeProject(pulls: string): { root: string; file: string; env: NodeJS.ProcessEnv } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typescript-native-lsp-fake-'));
	tempDirs.push(root);
	const pkg = path.join(root, 'node_modules', 'typescript');
	fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
	fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'typescript', version: '7.0.2' }));
	fs.copyFileSync(path.join(here, 'helpers', 'fake-native-server.mjs'), path.join(pkg, 'lib', 'tsc.js'));
	fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
	return { root, file: path.join(root, 'a.ts'), env: { FAKE_PULLS: pulls, PATH: '' } };
}

test('TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS=0 runs the native server without pushed file diagnostics', { skip }, async () => {
	const file = path.join(ts7, 'error.ts');
	const session = startSession(ts7, { env: { TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS: '0' } });
	try {
		await session.initialize();
		session.openFile(file);
		assert.equal(await session.receivesNotification(diagnosticsFor(file)), false);
		assert.match(session.stderr, /launching/);
		assert.doesNotMatch(session.stderr, /diagnostics bridge on/);
	} finally {
		await session.close();
	}
});

test('a client that only advertises pull diagnostics still gets them pushed', { skip }, async () => {
	const file = path.join(ts7, 'error.ts');
	const session = startSession(ts7, { capabilities: { ...claudeCodeClient.capabilities, textDocument: { ...claudeCodeClient.capabilities.textDocument, diagnostic: { dynamicRegistration: false } } } });
	try {
		await session.initialize();
		session.openFile(file);
		assert.equal(await session.receivesNotification(diagnosticsFor(file)), true);
		assert.doesNotMatch(session.stderr, /bridge disabled/);
	} finally {
		await session.close();
	}
});

test('a client that requests diagnostics itself switches the bridge off', { skip }, async () => {
	const file = path.join(ts7, 'error.ts');
	const session = startSession(ts7);
	try {
		await session.initialize();
		session.openFile(file);
		const pulled = await session.request('textDocument/diagnostic', { textDocument: { uri: uriOf(file) } });
		assert.equal(pulled.error, undefined, JSON.stringify(pulled));
		assert.match(session.stderr, /bridge disabled/);
		const before = session.notifications.length;
		session.changeFile(file, 2, 'export const wrong: string = 1;\n');
		assert.equal(await session.receivesNotification(message => session.notifications.indexOf(message) >= before && diagnosticsFor(file)(message)), false);
	} finally {
		await session.close();
	}
});

test('the bridge never forwards its own pull responses to the client', { skip }, async () => {
	const file = path.join(ts7, 'error.ts');
	const session = startSession(ts7);
	try {
		await session.initialize();
		session.openFile(file);
		await session.waitForNotification(diagnosticsFor(file));
		assert.deepEqual(session.unexpectedResponses, []);
	} finally {
		await session.close();
	}
});

test('a burst of edits publishes for the final version only', { skip }, async () => {
	const file = path.join(ts7, 'error.ts');
	const session = startSession(ts7);
	try {
		await session.initialize();
		session.openFile(file);
		for (let version = 2; version <= 6; version++) {
			session.changeFile(file, version, `export const v${version}: string = ${version};\n`);
		}
		const published = await session.waitForNotification(diagnosticsFor(file));
		assert.equal(published.params.version, 6);
		assert.equal(await session.receivesNotification(message => diagnosticsFor(file)(message) && 6 !== message.params.version, { withinMs: 1000 }), false);
	} finally {
		await session.close();
	}
});

test('an empty first pull is retried once and the retry is published', async () => {
	const { root, file, env } = fakeProject('empty,items');
	const session = startSession(root, { env });
	try {
		await session.initialize();
		session.openFile(file);
		const published = await session.waitForNotification((message): message is Diagnostics => diagnosticsFor(file)(message) && message.params.diagnostics.length > 0);
		assert.equal(published.params.diagnostics[0]?.message, 'pull 2');
	} finally {
		await session.close();
	}
});

test('a failed pull is retried once', async () => {
	const { root, file, env } = fakeProject('error,items');
	const session = startSession(root, { env });
	try {
		await session.initialize();
		session.openFile(file);
		const published = await session.waitForNotification(diagnosticsFor(file));
		assert.equal(published.params.diagnostics[0]?.message, 'pull 2');
	} finally {
		await session.close();
	}
});

test('a pull that keeps failing is not retried forever', async () => {
	const { root, file, env } = fakeProject('error');
	const session = startSession(root, { env: { ...env, TYPESCRIPT_NATIVE_LSP_DEBUG: '1' } });
	try {
		await session.initialize();
		session.openFile(file);
		assert.equal(await session.receivesNotification(diagnosticsFor(file), { withinMs: 1500 }), false);
		assert.equal((session.stderr.match(/pull failed/g) ?? []).length, 2);
	} finally {
		await session.close();
	}
});

test('related documents in a pull result are published too', async () => {
	const { root, file, env } = fakeProject('related');
	const session = startSession(root, { env });
	try {
		await session.initialize();
		session.openFile(file);
		const related = await session.waitForNotification(diagnosticsFor(path.join(root, 'other.ts')));
		assert.equal(related.params.diagnostics[0]?.code, 2304);
		assert.equal(related.params.version, undefined);
	} finally {
		await session.close();
	}
});
