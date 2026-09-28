import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameReader, exitStatus } from '../scripts/proxy.mjs';

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

test('frame reader forwards a replacement message returned by inspect', () => {
	const written = [];
	const reader = createFrameReader({ wants: () => true, inspect: message => ({ ...message, rewritten: true }), target: { write: chunk => written.push(Buffer.from(chunk)) } });
	const body = '{"jsonrpc":"2.0","method":"m","params":{}}';
	reader.push(Buffer.from(`Content-Length: ${body.length}\r\n\r\n${body}`));
	const out = Buffer.concat(written).toString('utf8');
	const json = out.slice(out.indexOf('\r\n\r\n') + 4);
	assert.equal(Number(/Content-Length: (\d+)/.exec(out)[1]), Buffer.byteLength(json));
	assert.deepEqual(JSON.parse(json), { jsonrpc: '2.0', method: 'm', params: {}, rewritten: true });
});

test('exit status mirrors a signal as 128 plus its number', () => {
	assert.equal(exitStatus(null, 'SIGTERM'), 143);
	assert.equal(exitStatus(3, null), 3);
	assert.equal(exitStatus(null, null), 1);
});
