import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, '..', 'scripts', 'launch.mjs');
const fixtures = path.join(here, 'fixtures');

function fixture(name) {
	return path.join(fixtures, name);
}

function installed(name) {
	return fs.existsSync(path.join(fixture(name), 'node_modules'));
}

function envFor(projectDir) {
	return { ...process.env, CLAUDE_PROJECT_DIR: projectDir, TYPESCRIPT_NATIVE_LSP_TSDK: '' };
}

/** Starts the launcher for a project, performs the LSP initialize handshake and returns the server's response. */
function initialize(projectDir) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [launcher], { cwd: projectDir, env: envFor(projectDir), stdio: ['pipe', 'pipe', 'pipe'] });
		let buffer = Buffer.alloc(0);
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`no initialize response within 30s\nstderr:\n${stderr}\nstdout:\n${buffer.toString('utf8')}`));
		}, 30000);
		child.stderr.on('data', chunk => (stderr += chunk));
		child.stdout.on('data', chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			for (let message = readMessage(); null !== message; message = readMessage()) {
				if (1 !== message.id) {
					continue;
				}
				clearTimeout(timer);
				child.kill();
				resolve({ message, stderr });
				return;
			}
		});
		child.on('error', reject);
		/** Consumes one complete LSP message from the buffer, or returns null when none is complete yet. */
		function readMessage() {
			const headerEnd = buffer.indexOf('\r\n\r\n');
			if (-1 === headerEnd) {
				return null;
			}
			const header = buffer.subarray(0, headerEnd).toString('ascii');
			const length = Number.parseInt(/Content-Length: (\d+)/.exec(header)[1], 10);
			const bodyStart = headerEnd + 4;
			if (buffer.length < bodyStart + length) {
				return null;
			}
			const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString('utf8'));
			buffer = buffer.subarray(bodyStart + length);
			return message;
		}
		const request = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { processId: process.pid, rootUri: pathToFileURL(projectDir).href, capabilities: {} },
		});
		child.stdin.write(`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`);
	});
}

test('--resolve prints the plan as JSON', { skip: false === installed('ts7') && 'run npm run fixtures' }, () => {
	const result = spawnSync(process.execPath, [launcher, '--resolve'], { cwd: fixture('ts7'), env: envFor(fixture('ts7')), encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	const plan = JSON.parse(result.stdout);
	assert.equal(plan.projectDir, fixture('ts7'));
	assert.deepEqual(plan.args, ['--lsp', '--stdio']);
});

test('unresolvable project exits 1 with a message on stderr and nothing on stdout', () => {
	const result = spawnSync(process.execPath, [launcher], { cwd: fixture('none'), env: { ...envFor(fixture('none')), PATH: '' }, encoding: 'utf8' });
	assert.equal(result.status, 1);
	assert.equal(result.stdout, '');
	assert.match(result.stderr, /\[typescript-native-lsp\] no TypeScript found/);
});

test('TypeScript 7 project completes the initialize handshake with the native server', { skip: false === installed('ts7') && 'run npm run fixtures' }, async () => {
	const { message, stderr } = await initialize(fixture('ts7'));
	assert.equal(message.error, undefined, JSON.stringify(message));
	assert.match(message.result.serverInfo.version, /^7\./);
	assert.equal(message.result.capabilities.hoverProvider, true);
	assert.equal(message.result.capabilities.callHierarchyProvider, true);
	assert.match(stderr, /TypeScript 7\.0\.2 via node_modules\/\.bin\/tsc/);
});

test('aliased project completes the initialize handshake with the native server', { skip: false === installed('aliased') && 'run npm run fixtures' }, async () => {
	const { message } = await initialize(fixture('aliased'));
	assert.match(message.result.serverInfo.version, /^7\./);
});

test('TypeScript 6 project completes the initialize handshake with typescript-language-server', { skip: false === installed('ts6') && 'run npm run fixtures' }, async () => {
	const { message, stderr } = await initialize(fixture('ts6'));
	assert.equal(message.error, undefined, JSON.stringify(message));
	assert.equal(message.result.capabilities.hoverProvider, true);
	assert.match(stderr, /TypeScript 6\.0\.3 .* typescript-language-server/);
});
