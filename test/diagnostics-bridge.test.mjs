/**
 * Tests of the pull-to-push bridge's own switches and framing. Delete together
 * with scripts/diagnostics-bridge.mjs; the behavioural contract lives in
 * diagnostics.test.mjs and must keep passing without the bridge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFrameReader } from '../scripts/diagnostics-bridge.mjs';
import { startSession, diagnosticsFor, claudeCodeClient } from './helpers/lsp-session.mjs';

const ts7 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ts7');
const skip = false === fs.existsSync(path.join(ts7, 'node_modules')) && 'run npm run fixtures';

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

test('frame reader forwards untouched frames byte for byte and withholds consumed ones', () => {
	const written = [];
	const seen = [];
	const reader = createFrameReader(message => {
		seen.push(message);
		return 'keep' === message.method;
	}, { write: chunk => written.push(Buffer.from(chunk)) });
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

test('frame reader rejects a frame without Content-Length', () => {
	const reader = createFrameReader(() => true, { write() {} });
	assert.throws(() => reader.push(Buffer.from('Content-Type: text\r\n\r\n{}')), /Content-Length/);
});
