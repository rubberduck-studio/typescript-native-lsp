import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameReader, writeMessage } from '../scripts/protocol.mts';
import { exitStatus } from '../scripts/server.mts';

const frameOf = (body: string): string => `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

test('frame reader hands over each frame byte for byte, however the stream is chunked', () => {
	const frames: string[] = [];
	const methods: Array<string | undefined> = [];
	const reader = createFrameReader((frame, parse) => {
		frames.push(frame.toString('utf8'));
		methods.push(parse().method);
	});
	const first = frameOf('{"jsonrpc":"2.0","method":"a","params":{"text":"ünïcödé"}}');
	const second = frameOf('{"jsonrpc":"2.0","id":"x","result":null}');
	const bytes = Buffer.from(first + second + first, 'utf8');
	for (let offset = 0; offset < bytes.length; offset += 7) {
		reader.push(bytes.subarray(offset, offset + 7));
	}
	assert.deepEqual(frames, [first, second, first]);
	assert.deepEqual(methods, ['a', undefined, 'a']);
});

test('frame reader parses nothing unless asked', () => {
	const frames: string[] = [];
	const frame = 'Content-Length: 12\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\nnot json {{{';
	createFrameReader(bytes => frames.push(bytes.toString('utf8'))).push(Buffer.from(frame));
	assert.deepEqual(frames, [frame]);
});

test('frame reader rejects a body that is not JSON-RPC 2.0 when parsed', () => {
	const reader = createFrameReader((_frame, parse) => parse());
	assert.throws(() => reader.push(Buffer.from(frameOf('{"id":1}'))), /JSON-RPC/);
});

test('frame reader joins a large body once instead of per chunk', () => {
	const bytes = Buffer.from(frameOf(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(8 * 1024 * 1024) })));
	let frames = 0;
	const reader = createFrameReader(() => ++frames);
	const started = process.hrtime.bigint();
	for (let offset = 0; offset < bytes.length; offset += 65536) {
		reader.push(bytes.subarray(offset, offset + 65536));
	}
	const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
	assert.equal(frames, 1);
	assert.ok(elapsedMs < 500, `took ${elapsedMs}ms`);
});

test('frame reader rejects a frame without Content-Length', () => {
	const reader = createFrameReader(() => {});
	assert.throws(() => reader.push(Buffer.from('Content-Type: text\r\n\r\n{}')), /Content-Length/);
});

test('written messages declare their length in bytes, not characters', () => {
	const written: Buffer[] = [];
	writeMessage({ write: (chunk: string | Uint8Array) => written.push(Buffer.from(chunk)) > 0 }, { jsonrpc: '2.0', method: 'm', params: { text: 'ünïcödé' } });
	const out = Buffer.concat(written);
	const bodyStart = out.indexOf('\r\n\r\n') + 4;
	assert.equal(Number(/Content-Length: (\d+)/.exec(out.toString('ascii'))?.[1]), out.length - bodyStart);
	assert.deepEqual(JSON.parse(out.subarray(bodyStart).toString('utf8')), { jsonrpc: '2.0', method: 'm', params: { text: 'ünïcödé' } });
});

test('exit status mirrors a signal as 128 plus its number', () => {
	assert.equal(exitStatus(null, 'SIGTERM'), 143);
	assert.equal(exitStatus(3, null), 3);
	assert.equal(exitStatus(null, null), 1);
});
