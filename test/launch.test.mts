import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { InitializeResult } from 'vscode-languageserver-protocol';
import { startSession, hoverText } from './helpers/lsp-session.mts';


const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, '..', 'scripts', 'launch.mjs');
const fixtures = path.join(here, 'fixtures');
const lspConfig: { command: string; args: string[]; extensionToLanguage: Record<string, string>; env?: Record<string, string> } = JSON.parse(fs.readFileSync(path.join(here, '..', '.lsp.json'), 'utf8')).typescript;
const manifest: { userConfig?: Record<string, { default?: unknown }> } = JSON.parse(fs.readFileSync(path.join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8'));

function fixture(name: string): string {
	return path.join(fixtures, name);
}

function installed(name: string): boolean {
	return fs.existsSync(path.join(fixture(name), 'node_modules'));
}

function envFor(projectDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
	for (const key of Object.keys(env)) {
		if (key.startsWith('TYPESCRIPT_NATIVE_LSP_')) {
			delete env[key];
		}
	}
	env.TYPESCRIPT_NATIVE_LSP_GLOBAL_ROOTS = '';
	return env;
}

async function initialize(projectDir: string): Promise<{ result: InitializeResult; stderr: string }> {
	const session = startSession(projectDir);
	try {
		const message = await session.initialize();
		assert.equal(message.error, undefined, JSON.stringify(message));
		assert.ok(isInitializeResult(message.result), JSON.stringify(message));
		return { result: message.result, stderr: session.stderr };
	} finally {
		await session.close();
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
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'typescript-native-lsp-empty-'));
	fs.writeFileSync(path.join(empty, 'package-lock.json'), '{}');
	const result = spawnSync(process.execPath, [launcher], { cwd: empty, env: { ...envFor(empty), PATH: '' }, encoding: 'utf8' });
	fs.rmSync(empty, { recursive: true, force: true });
	assert.equal(result.status, 1);
	assert.equal(result.stdout, '');
	assert.match(result.stderr, /\[typescript-native-lsp\] no TypeScript found/);
});

test('TypeScript 7 project completes the initialize handshake with the native server', { skip: false === installed('ts7') && 'run npm run fixtures' }, async () => {
	const { result, stderr } = await initialize(fixture('ts7'));
	assert.match(result.serverInfo?.version ?? '', /^7\./);
	assert.equal(result.capabilities.hoverProvider, true);
	assert.equal(result.capabilities.callHierarchyProvider, true);
	assert.match(stderr, /TypeScript 7\.\S+ via node_modules\/typescript/);
});

test('aliased project completes the initialize handshake with the native server', { skip: false === installed('aliased') && 'run npm run fixtures' }, async () => {
	const { result } = await initialize(fixture('aliased'));
	assert.match(result.serverInfo?.version ?? '', /^7\./);
});

test('TypeScript 6 project completes the initialize handshake with typescript-language-server', { skip: false === installed('ts6') && 'run npm run fixtures' }, async () => {
	const { result, stderr } = await initialize(fixture('ts6'));
	assert.equal(result.capabilities.hoverProvider, true);
	assert.match(stderr, /TypeScript 6\.0\.3 .* typescript-language-server/);
});

test('.lsp.json points Claude Code at the launcher the tests exercise', () => {
	assert.equal(lspConfig.command, 'node');
	const script = (lspConfig.args[0] ?? '').replace('${CLAUDE_PLUGIN_ROOT}', path.join(here, '..'));
	assert.equal(path.resolve(script), launcher);
	const readme = fs.readFileSync(path.join(here, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
	const documented = (/## Supported Extensions\n(.*)\n/.exec(readme)?.[1]?.match(/`(\.[a-z]+)`/g) ?? []).map(s => s.replaceAll('`', ''));
	assert.deepEqual(Object.keys(lspConfig.extensionToLanguage).sort(), documented.sort());
});

for (const name of ['ts7', 'ts6']) {
	/** The status is the server's own: typescript-language-server exits 0, TypeScript 7.0.2 exits 1 ("context canceled"). What matters is that the launcher ends with it. */
	test(`${name}: shutdown and exit end the launcher with the server's status`, { skip: false === installed(name) && 'run npm run fixtures' }, async () => {
		const session = startSession(fixture(name));
		await session.initialize();
		await session.request('shutdown');
		session.notify('exit');
		const { code, signal } = await session.exited();
		assert.equal(signal, null);
		assert.ok(0 === code || 1 === code, `code ${code}`);
	});

	test(`${name}: a termination signal ends the launcher and its server`, { skip: (false === installed(name) && 'run npm run fixtures') || ('win32' === process.platform && 'POSIX signals') }, async () => {
		const session = startSession(fixture(name));
		await session.initialize();
		session.child.kill('SIGTERM');
		const { code, signal } = await session.exited();
		assert.ok('SIGTERM' === signal || 143 === code || 1 === code, `code ${code} signal ${signal}`);
	});
}

function isInitializeResult(value: unknown): value is InitializeResult {
	return 'object' === typeof value && null !== value && 'capabilities' in value && 'object' === typeof value.capabilities;
}

test('a Node that cannot strip types gets an explanation on stderr instead of a syntax error', () => {
	const result = spawnSync(process.execPath, ['--no-experimental-strip-types', launcher, '--resolve'], { cwd: fixture('ts7'), env: envFor(fixture('ts7')), encoding: 'utf8' });
	assert.equal(result.status, 1);
	assert.equal(result.stdout, '');
	assert.match(result.stderr, /cannot strip TypeScript types/);
	assert.doesNotMatch(result.stderr, /SyntaxError/);
});

for (const [name, env, expected] of [
	['ts7', {}, ['document-sync', 'diagnostics-bridge']],
	['ts6', {}, ['document-sync']],
	['ts7', { TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS: '0' }, ['document-sync']],
	['ts7', { TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS: 'false' }, ['document-sync']],
	['ts7', { TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC: '0' }, ['diagnostics-bridge']],
	['ts7', { TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC: 'false', TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS: 'true' }, ['diagnostics-bridge']],
	['ts7', { TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC: 'off', TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS: 'Yes' }, ['diagnostics-bridge']],
	['ts7', { TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC: 'nope' }, ['document-sync', 'diagnostics-bridge']],
	['ts6', { TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC: '0' }, []],
] satisfies Array<[string, NodeJS.ProcessEnv, string[]]>) {
	test(`${name} with ${JSON.stringify(env)} runs the proxy features ${JSON.stringify(expected)}`, { skip: false === installed(name) && 'run npm run fixtures' }, () => {
		const result = spawnSync(process.execPath, [launcher, '--resolve'], { cwd: fixture(name), env: { ...envFor(fixture(name)), ...env }, encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr);
		const parsed: unknown = JSON.parse(result.stdout);
		assert.ok('object' === typeof parsed && null !== parsed && 'proxyFeatures' in parsed, result.stdout);
		assert.deepEqual(parsed.proxyFeatures, expected);
		assert.equal(result.stderr.includes('ignoring TYPESCRIPT_NATIVE_LSP_'), Object.values(env).includes('nope'), result.stderr);
	});
}

for (const [value, expected] of [
	[undefined, 600],
	['0', 0],
	['90', 90],
	['99999999', 99999999],
	['soon', 600],
	['-5', 600],
] satisfies Array<[string | undefined, number]>) {
	test(`TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS=${String(value)} resolves to ${expected} seconds`, { skip: false === installed('ts7') && 'run npm run fixtures' }, () => {
		const env = undefined === value ? {} : { TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS: value };
		const result = spawnSync(process.execPath, [launcher, '--resolve'], { cwd: fixture('ts7'), env: { ...envFor(fixture('ts7')), ...env }, encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr);
		const parsed: unknown = JSON.parse(result.stdout);
		assert.ok('object' === typeof parsed && null !== parsed && 'idleSeconds' in parsed, result.stdout);
		assert.equal(parsed.idleSeconds, expected);
		assert.equal(result.stderr.includes('ignoring TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS'), 600 === expected && undefined !== value);
	});
}

test('every plugin option reaches the launcher through .lsp.json, with the same default on both sides', { skip: false === installed('ts7') && 'run npm run fixtures' }, () => {
	const passed = new Map<string, string>();
	for (const [variable, reference] of Object.entries(lspConfig.env ?? {})) {
		const option = /^\$\{user_config\.(\w+)\}$/.exec(reference)?.[1];
		assert.ok(undefined !== option, `.lsp.json must pass ${variable} a plugin option, got ${reference}`);
		passed.set(option, variable);
	}
	assert.deepEqual([...passed.keys()].sort(), Object.keys(manifest.userConfig ?? {}).sort(), 'plugin.json options and the ones .lsp.json passes on must match');
	const result = spawnSync(process.execPath, [launcher, '--resolve'], { cwd: fixture('ts7'), env: envFor(fixture('ts7')), encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	const resolved: { idleSeconds: number; proxyFeatures: string[] } = JSON.parse(result.stdout);
	const defaults = Object.fromEntries(Object.entries(manifest.userConfig ?? {}).map(([option, { default: value }]) => [passed.get(option), value]));
	assert.deepEqual(defaults, {
		TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS: resolved.idleSeconds,
		TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC: resolved.proxyFeatures.includes('document-sync'),
		TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS: resolved.proxyFeatures.includes('diagnostics-bridge'),
	});
});

test('with idle shutdown and both features off, the server runs directly and still answers', { skip: false === installed('ts7') && 'run npm run fixtures' }, async () => {
	const file = path.join(fixture('ts7'), 'error.ts');
	const session = startSession(fixture('ts7'), { env: { TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS: '0', TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC: 'false', TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS: 'false' } });
	try {
		await session.initialize();
		session.openFile(file);
		assert.notEqual(await hoverText(session, file, 0, 13), '');
		assert.doesNotMatch(session.stderr, /idle shutdown after|document sync on|diagnostics bridge on/);
	} finally {
		await session.close();
	}
});
