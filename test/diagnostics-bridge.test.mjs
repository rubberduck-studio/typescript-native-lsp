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
import { createFrameReader } from '../scripts/diagnostics-bridge.mjs';
import { startSession, diagnosticsFor, claudeCodeClient } from './helpers/lsp-session.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ts7 = path.join(here, 'fixtures', 'ts7');
const skip = false === fs.existsSync(path.join(ts7, 'node_modules')) && 'run npm run fixtures';

const tempDirs = [];
after(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * A project whose "TypeScript 7" is the fake server: the launcher finds a
 * typescript package without a platform binary and runs its lib/tsc.js with
 * node, which is exactly the fake. FAKE_PULLS scripts the server's answers.
 */
function fakeProject(pulls) {
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
		session.close();
	}
});

test('a client that advertises pull diagnostics switches the bridge off', { skip }, async () => {
	const file = path.join(ts7, 'error.ts');
	const session = startSession(ts7, { capabilities: { ...claudeCodeClient.capabilities, textDocument: { ...claudeCodeClient.capabilities.textDocument, diagnostic: { dynamicRegistration: false } } } });
	try {
		await session.initialize();
		session.openFile(file);
		assert.equal(await session.receivesNotification(diagnosticsFor(file)), false);
		assert.match(session.stderr, /bridge disabled/);
	} finally {
		session.close();
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
		session.close();
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
		session.close();
	}
});

test('an empty first pull is retried once and the retry is published', async () => {
	const { root, file, env } = fakeProject('empty,items');
	const session = startSession(root, { env });
	try {
		await session.initialize();
		session.openFile(file);
		const published = await session.waitForNotification(message => diagnosticsFor(file)(message) && message.params.diagnostics.length > 0);
		assert.equal(published.params.diagnostics[0].message, 'pull 2');
	} finally {
		session.close();
	}
});

test('a failed pull is retried once', async () => {
	const { root, file, env } = fakeProject('error,items');
	const session = startSession(root, { env });
	try {
		await session.initialize();
		session.openFile(file);
		const published = await session.waitForNotification(diagnosticsFor(file));
		assert.equal(published.params.diagnostics[0].message, 'pull 2');
	} finally {
		session.close();
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
		session.close();
	}
});

test('related documents in a pull result are published too', async () => {
	const { root, file, env } = fakeProject('related');
	const session = startSession(root, { env });
	try {
		await session.initialize();
		session.openFile(file);
		const related = await session.waitForNotification(diagnosticsFor(path.join(root, 'other.ts')));
		assert.equal(related.params.diagnostics[0].code, 2304);
		assert.equal(related.params.version, undefined);
	} finally {
		session.close();
	}
});

test('frame reader forwards untouched frames byte for byte and withholds consumed ones', () => {
	const written = [];
	const seen = [];
	const reader = createFrameReader({
		wants: () => true,
		inspect(message) {
			seen.push(message);
			return 'keep' === message.method;
		},
		target: { write: chunk => written.push(Buffer.from(chunk)) },
	});
	const frame = body => `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
	const keep = frame('{"jsonrpc":"2.0","method":"keep","params":{"text":"ünïcödé"}}');
	const drop = frame('{"jsonrpc":"2.0","id":"x","result":null}');
	const bytes = Buffer.from(keep + drop + keep, 'utf8');
	for (let offset = 0; offset < bytes.length; offset += 7) {
		reader.push(bytes.subarray(offset, offset + 7));
	}
	assert.equal(seen.length, 3);
	assert.equal(written.length, 2);
	assert.equal(Buffer.concat(written).toString('utf8'), keep + keep);
});

test('frame reader forwards unwanted frames without parsing them', () => {
	const written = [];
	const reader = createFrameReader({ wants: () => false, inspect: () => assert.fail('must not parse'), target: { write: chunk => written.push(Buffer.from(chunk)) } });
	const frame = 'Content-Length: 12\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\nnot json {{{';
	reader.push(Buffer.from(frame));
	assert.equal(Buffer.concat(written).toString('utf8'), frame);
});

test('frame reader joins a large body once instead of per chunk', () => {
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(8 * 1024 * 1024) });
	const bytes = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	let frames = 0;
	const reader = createFrameReader({ wants: () => false, inspect: () => true, target: { write: () => frames++ } });
	const started = process.hrtime.bigint();
	for (let offset = 0; offset < bytes.length; offset += 65536) {
		reader.push(bytes.subarray(offset, offset + 65536));
	}
	const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
	assert.equal(frames, 1);
	assert.ok(elapsedMs < 500, `took ${elapsedMs}ms`);
});

test('frame reader rejects a frame without Content-Length', () => {
	const reader = createFrameReader({ wants: () => true, inspect: () => true, target: { write() {} } });
	assert.throws(() => reader.push(Buffer.from('Content-Type: text\r\n\r\n{}')), /Content-Length/);
});
