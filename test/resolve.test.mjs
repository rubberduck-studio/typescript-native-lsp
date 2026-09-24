import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServer, ResolveError } from '../scripts/resolve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const platform = process.platform;
const nativeBinary = path.join('lib', 'win32' === platform ? 'tsc.exe' : 'tsc');
const emptyEnv = { PATH: '' };

function fixture(name) {
	return path.join(fixtures, name);
}

function installed(name) {
	return fs.existsSync(path.join(fixture(name), 'node_modules'));
}

function tempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typescript-native-lsp-'));
	return dir;
}

function writeJson(filePath, data) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data));
}

/** Writes a fake `typescript` package: package.json plus lib/tsc.js, without a platform binary. */
function writeFakeTypescript(dir, version) {
	writeJson(path.join(dir, 'package.json'), { name: 'typescript', version, bin: { tsc: './bin/tsc' } });
	fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'lib', 'tsc.js'), '');
	fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'bin', 'tsc'), '');
}

/** The shell shim npm writes into node_modules/.bin on Windows. */
function writeNpmShim(binPath, relativeTarget) {
	fs.mkdirSync(path.dirname(binPath), { recursive: true });
	fs.writeFileSync(
		binPath,
		[
			'#!/bin/sh',
			'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
			'if [ -x "$basedir/node" ]; then',
			`  exec "$basedir/node"  "$basedir/${relativeTarget}" "$@"`,
			'else ',
			`  exec node  "$basedir/${relativeTarget}" "$@"`,
			'fi',
		].join('\n'),
	);
}

test('TypeScript 7 project resolves to the native platform binary', { skip: false === installed('ts7') && 'run npm run fixtures' }, () => {
	const plan = resolveServer({ projectDir: fixture('ts7'), env: emptyEnv });
	assert.ok(plan.command.endsWith(path.join(`@typescript`, `typescript-${platform}-${process.arch}`, nativeBinary)), plan.command);
	assert.deepEqual(plan.args, ['--lsp', '--stdio']);
	assert.equal(plan.shell, false);
	assert.equal(plan.typescript.version, '7.0.2');
	assert.match(plan.reason, /node_modules\/\.bin\/tsc/);
});

test('TypeScript 6 project resolves to the project-local typescript-language-server', { skip: false === installed('ts6') && 'run npm run fixtures' }, () => {
	const plan = resolveServer({ projectDir: fixture('ts6'), env: emptyEnv });
	assert.equal(plan.command, process.execPath);
	assert.ok(plan.args[0].endsWith(path.join('typescript-language-server', 'lib', 'cli.mjs')), plan.args[0]);
	assert.equal(plan.args[1], '--stdio');
	assert.equal(plan.typescript.version, '6.0.3');
});

test('aliased install follows .bin/tsc to TypeScript 7 although node_modules/typescript is 6', { skip: false === installed('aliased') && 'run npm run fixtures' }, () => {
	const plan = resolveServer({ projectDir: fixture('aliased'), env: emptyEnv });
	assert.ok(plan.command.endsWith(nativeBinary), plan.command);
	assert.equal(plan.typescript.version, '7.0.2');
	assert.ok(plan.typescript.dir.endsWith(path.join('@typescript', 'native')), plan.typescript.dir);
});

test('nested directory walks up to the project TypeScript', { skip: false === installed('ts7') && 'run npm run fixtures' }, () => {
	const plan = resolveServer({ projectDir: path.join(fixture('ts7'), 'src', 'deep'), env: emptyEnv });
	assert.equal(plan.typescript.version, '7.0.2');
});

test('npm shell shim is parsed to find the package behind tsc', () => {
	const root = tempDir();
	writeFakeTypescript(path.join(root, 'node_modules', '@scope', 'ts-alias'), '7.1.0');
	writeFakeTypescript(path.join(root, 'node_modules', 'typescript'), '6.0.2');
	writeNpmShim(path.join(root, 'node_modules', '.bin', 'tsc'), '../@scope/ts-alias/bin/tsc');
	const plan = resolveServer({ projectDir: root, env: emptyEnv });
	assert.equal(plan.typescript.version, '7.1.0');
	assert.equal(plan.command, process.execPath);
	assert.equal(plan.args[0], path.join(root, 'node_modules', '@scope', 'ts-alias', 'lib', 'tsc.js'));
	assert.deepEqual(plan.args.slice(1), ['--lsp', '--stdio']);
});

test('TypeScript 7 without a platform package falls back to running lib/tsc.js with node', () => {
	const root = tempDir();
	writeFakeTypescript(path.join(root, 'node_modules', 'typescript'), '7.0.2');
	const plan = resolveServer({ projectDir: root, env: emptyEnv });
	assert.equal(plan.command, process.execPath);
	assert.equal(plan.args[0], path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'));
});

test('workspace packages under a lockfile root are scanned and the highest version wins', () => {
	const root = tempDir();
	fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
	writeFakeTypescript(path.join(root, 'packages', 'a', 'node_modules', 'typescript'), '6.0.3');
	writeFakeTypescript(path.join(root, 'apps', 'b', 'node_modules', 'typescript'), '7.0.2');
	const plan = resolveServer({ projectDir: path.join(root, 'tools'), env: emptyEnv });
	assert.equal(plan.typescript.version, '7.0.2');
	assert.match(plan.reason, /workspace package apps\/b/);
});

test('walk-up stops at the lockfile root', () => {
	const outer = tempDir();
	writeFakeTypescript(path.join(outer, 'node_modules', 'typescript'), '7.0.2');
	const inner = path.join(outer, 'project');
	fs.mkdirSync(inner);
	fs.writeFileSync(path.join(inner, 'package-lock.json'), '');
	assert.throws(() => resolveServer({ projectDir: inner, env: emptyEnv }), ResolveError);
});

test('TYPESCRIPT_NATIVE_LSP_TSDK overrides project resolution', () => {
	const root = tempDir();
	writeFakeTypescript(path.join(root, 'node_modules', 'typescript'), '6.0.3');
	const tsdk = path.join(root, 'elsewhere', 'typescript');
	writeFakeTypescript(tsdk, '7.0.2');
	const plan = resolveServer({ projectDir: root, env: { ...emptyEnv, TYPESCRIPT_NATIVE_LSP_TSDK: tsdk } });
	assert.equal(plan.typescript.dir, tsdk);
	assert.match(plan.reason, /TYPESCRIPT_NATIVE_LSP_TSDK/);
});

test('TYPESCRIPT_NATIVE_LSP_TSDK pointing at a non-typescript directory is an error', () => {
	const root = tempDir();
	assert.throws(() => resolveServer({ projectDir: root, env: { ...emptyEnv, TYPESCRIPT_NATIVE_LSP_TSDK: root } }), /not a typescript package directory/);
});

test('TypeScript 6 without any typescript-language-server is an error', () => {
	const root = tempDir();
	writeFakeTypescript(path.join(root, 'node_modules', 'typescript'), '6.0.3');
	assert.throws(() => resolveServer({ projectDir: root, env: emptyEnv, execPath: path.join(root, 'nowhere', 'bin', 'node') }), /needs typescript-language-server/);
});

test('nothing installed anywhere is an error naming what was tried', () => {
	const root = tempDir();
	assert.throws(() => resolveServer({ projectDir: root, env: emptyEnv, execPath: path.join(root, 'nowhere', 'bin', 'node') }), /no tsc\/tsgo 7\+ on PATH/);
});

test('tsc 7 on PATH is used when the project has no TypeScript', { skip: 'win32' === platform && 'POSIX shell script fixture' }, () => {
	const root = tempDir();
	const binDir = path.join(root, 'bin');
	fs.mkdirSync(binDir);
	const fakeTsc = path.join(binDir, 'tsc');
	fs.writeFileSync(fakeTsc, '#!/bin/sh\necho "Version 7.0.2"\n');
	fs.chmodSync(fakeTsc, 0o755);
	const plan = resolveServer({ projectDir: root, env: { PATH: binDir }, execPath: path.join(root, 'nowhere', 'bin', 'node') });
	assert.equal(plan.command, fakeTsc);
	assert.deepEqual(plan.args, ['--lsp', '--stdio']);
	assert.match(plan.reason, /tsc 7\.0\.2 on PATH/);
});

test('tsc 6 on PATH is skipped', { skip: 'win32' === platform && 'POSIX shell script fixture' }, () => {
	const root = tempDir();
	const binDir = path.join(root, 'bin');
	fs.mkdirSync(binDir);
	const fakeTsc = path.join(binDir, 'tsc');
	fs.writeFileSync(fakeTsc, '#!/bin/sh\necho "Version 6.0.3"\n');
	fs.chmodSync(fakeTsc, 0o755);
	assert.throws(() => resolveServer({ projectDir: root, env: { PATH: binDir }, execPath: path.join(root, 'nowhere', 'bin', 'node') }), ResolveError);
});
