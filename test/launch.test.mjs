import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startSession } from './helpers/lsp-session.mjs';

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
	const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
	for (const key of Object.keys(env)) {
		if (key.startsWith('TYPESCRIPT_NATIVE_LSP_')) {
			delete env[key];
		}
	}
	env.TYPESCRIPT_NATIVE_LSP_GLOBAL_ROOTS = '';
	return env;
}

async function initialize(projectDir) {
	const session = startSession(projectDir);
	try {
		const message = await session.initialize();
		return { message, stderr: session.stderr };
	} finally {
		session.close();
	}
}

test('--resolve prints the plan as JSON', { skip: false === installed('ts7') && 'run npm run fixtures' }, () => {
	const result = spawnSync(process.execPath, [launcher, '--resolve'], { cwd: fixture('ts7'), env: envFor(fixture('ts7')), encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	const plan = JSON.parse(result.stdout);
	assert.equal(plan.projectDir, fixture('ts7'));
	assert.deepEqual(plan.args, ['--lsp', '--stdio']);
	assert.equal(plan.native, true);
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
	assert.match(stderr, /TypeScript 7\.0\.2 via node_modules\/typescript/);
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
