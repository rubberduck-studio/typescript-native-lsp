import { test, after } from 'node:test';
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
/** Nothing on PATH, no global roots: only what the test lays out can be found. */
const hermetic = { env: { PATH: '' }, globalRoots: [] };
const noNode = path.join(os.tmpdir(), 'nowhere', 'bin', 'node');

const tempDirs = [];
after(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function fixture(name) {
	return path.join(fixtures, name);
}

function installed(name) {
	return fs.existsSync(path.join(fixture(name), 'node_modules'));
}

function tempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typescript-native-lsp-'));
	tempDirs.push(dir);
	return dir;
}

function writeJson(filePath, data) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data));
}

/** A fake `typescript` package: package.json plus lib/tsc.js, optionally lib/tsserver.js, no platform binary. */
function writeFakeTypescript(dir, version, { tsserver = false } = {}) {
	writeJson(path.join(dir, 'package.json'), { name: 'typescript', version });
	fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'lib', 'tsc.js'), '');
	if (tsserver) {
		fs.writeFileSync(path.join(dir, 'lib', 'tsserver.js'), '');
	}
}

function writeFakeLanguageServer(root) {
	const entry = path.join(root, 'typescript-language-server', 'lib', 'cli.mjs');
	fs.mkdirSync(path.dirname(entry), { recursive: true });
	fs.writeFileSync(entry, '');
	return entry;
}

function writeFakePlatformPackage(nodeModules) {
	const dir = path.join(nodeModules, '@typescript', `typescript-${platform}-${process.arch}`);
	writeJson(path.join(dir, 'package.json'), { name: `@typescript/typescript-${platform}-${process.arch}`, version: '7.0.2' });
	fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
	fs.writeFileSync(path.join(dir, nativeBinary), '');
	return path.join(dir, nativeBinary);
}

test('TypeScript 7 project resolves to the native platform binary', { skip: false === installed('ts7') && 'run npm run fixtures' }, () => {
	const plan = resolveServer({ projectDir: fixture('ts7'), ...hermetic });
	assert.ok(plan.command.endsWith(path.join('@typescript', `typescript-${platform}-${process.arch}`, nativeBinary)), plan.command);
	assert.deepEqual(plan.args, ['--lsp', '--stdio']);
	assert.equal(plan.native, true);
	assert.equal(plan.typescript.version, '7.0.2');
	assert.match(plan.reason, /via node_modules\/typescript/);
});

test('TypeScript 6 project resolves to the project-local typescript-language-server and names the TypeScript it will use', { skip: false === installed('ts6') && 'run npm run fixtures' }, () => {
	const plan = resolveServer({ projectDir: fixture('ts6'), ...hermetic });
	assert.equal(plan.command, process.execPath);
	assert.ok(plan.args[0].endsWith(path.join('typescript-language-server', 'lib', 'cli.mjs')), plan.args[0]);
	assert.equal(plan.args[1], '--stdio');
	assert.equal(plan.native, false);
	assert.equal(plan.typescript.version, '6.0.3');
	assert.ok(plan.reason.endsWith('which will use ' + path.join(fixture('ts6'), 'node_modules', 'typescript')), plan.reason);
});

test('aliased install picks the TypeScript 7 alias over the TypeScript 6 package named typescript', { skip: false === installed('aliased') && 'run npm run fixtures' }, () => {
	const plan = resolveServer({ projectDir: fixture('aliased'), ...hermetic });
	assert.ok(plan.command.endsWith(nativeBinary), plan.command);
	assert.equal(plan.typescript.version, '7.0.2');
	assert.ok(plan.typescript.dir.endsWith(path.join('@typescript', 'native')), plan.typescript.dir);
	assert.match(plan.reason, /alias of typescript/);
});

test('nested directory walks up to the project TypeScript', { skip: false === installed('ts7') && 'run npm run fixtures' }, () => {
	const plan = resolveServer({ projectDir: path.join(fixture('ts7'), 'src', 'deep'), ...hermetic });
	assert.equal(plan.typescript.version, '7.0.2');
});

test('an alias declared in package.json is found without any bin shim', () => {
	const root = tempDir();
	writeJson(path.join(root, 'package.json'), { name: 'p', devDependencies: { '@scope/ts-alias': 'npm:typescript@7.1.0', typescript: 'npm:@typescript/typescript6@6.0.2' } });
	writeFakeTypescript(path.join(root, 'node_modules', '@scope', 'ts-alias'), '7.1.0');
	writeFakeTypescript(path.join(root, 'node_modules', 'typescript'), '6.0.2');
	const plan = resolveServer({ projectDir: root, ...hermetic });
	assert.equal(plan.typescript.version, '7.1.0');
	assert.equal(plan.command, process.execPath);
	assert.equal(plan.args[0], path.join(root, 'node_modules', '@scope', 'ts-alias', 'lib', 'tsc.js'));
});

test('pnpm-style symlinked typescript resolves the platform binary next to the real package', { skip: 'win32' === platform && 'symlink layout' }, () => {
	const root = tempDir();
	const store = path.join(root, 'node_modules', '.pnpm', 'typescript@7.0.2', 'node_modules');
	writeFakeTypescript(path.join(store, 'typescript'), '7.0.2');
	const binary = writeFakePlatformPackage(store);
	fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
	fs.symlinkSync(path.join('.pnpm', 'typescript@7.0.2', 'node_modules', 'typescript'), path.join(root, 'node_modules', 'typescript'));
	const plan = resolveServer({ projectDir: root, ...hermetic });
	assert.equal(fs.realpathSync(plan.command), fs.realpathSync(binary));
});

test('TypeScript 7 without a platform package falls back to running lib/tsc.js with node', () => {
	const root = tempDir();
	writeFakeTypescript(path.join(root, 'node_modules', 'typescript'), '7.0.2');
	const plan = resolveServer({ projectDir: root, ...hermetic });
	assert.equal(plan.command, process.execPath);
	assert.equal(plan.args[0], path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'));
});

test('workspace packages under a lockfile root are scanned and the highest version wins', () => {
	const root = tempDir();
	fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
	writeFakeTypescript(path.join(root, 'packages', 'a', 'node_modules', 'typescript'), '6.0.3', { tsserver: true });
	writeFakeTypescript(path.join(root, 'apps', 'b', 'node_modules', 'typescript'), '7.0.2');
	const plan = resolveServer({ projectDir: path.join(root, 'tools'), ...hermetic });
	assert.equal(plan.typescript.version, '7.0.2');
	assert.match(plan.reason, /workspace package apps\/b/);
});

test('workspace scan follows symlinked package directories', { skip: 'win32' === platform && 'symlink layout' }, () => {
	const root = tempDir();
	fs.writeFileSync(path.join(root, 'package-lock.json'), '');
	const real = path.join(root, 'elsewhere', 'lib-a');
	writeFakeTypescript(path.join(real, 'node_modules', 'typescript'), '7.0.2');
	fs.mkdirSync(path.join(root, 'packages'));
	fs.symlinkSync(real, path.join(root, 'packages', 'lib-a'));
	const plan = resolveServer({ projectDir: root, ...hermetic });
	assert.equal(plan.typescript.version, '7.0.2');
});

test('walk-up stops at the lockfile root', () => {
	const outer = tempDir();
	writeFakeTypescript(path.join(outer, 'node_modules', 'typescript'), '7.0.2');
	const inner = path.join(outer, 'project');
	fs.mkdirSync(inner);
	fs.writeFileSync(path.join(inner, 'package-lock.json'), '');
	assert.throws(() => resolveServer({ projectDir: inner, ...hermetic }), ResolveError);
});

test('TYPESCRIPT_NATIVE_LSP_TSDK overrides project resolution, also as a relative path', () => {
	const root = tempDir();
	writeFakeTypescript(path.join(root, 'node_modules', 'typescript'), '6.0.3', { tsserver: true });
	const tsdk = path.join(root, 'elsewhere', 'typescript');
	writeFakeTypescript(tsdk, '7.0.2');
	const absolute = resolveServer({ projectDir: root, ...hermetic, env: { PATH: '', TYPESCRIPT_NATIVE_LSP_TSDK: tsdk } });
	assert.equal(absolute.typescript.dir, tsdk);
	assert.match(absolute.reason, /TYPESCRIPT_NATIVE_LSP_TSDK/);
	const previous = process.cwd();
	process.chdir(root);
	try {
		const relative = resolveServer({ projectDir: root, ...hermetic, env: { PATH: '', TYPESCRIPT_NATIVE_LSP_TSDK: path.join('elsewhere', 'typescript') } });
		assert.equal(fs.realpathSync(relative.typescript.dir), fs.realpathSync(tsdk));
	} finally {
		process.chdir(previous);
	}
});

test('TYPESCRIPT_NATIVE_LSP_TSDK rejects non-typescript directories and TypeScript 6', () => {
	const root = tempDir();
	assert.throws(() => resolveServer({ projectDir: root, ...hermetic, env: { PATH: '', TYPESCRIPT_NATIVE_LSP_TSDK: root } }), /not a typescript package directory/);
	const tsdk = path.join(root, 'ts6');
	writeFakeTypescript(tsdk, '6.0.3', { tsserver: true });
	assert.throws(() => resolveServer({ projectDir: root, ...hermetic, env: { PATH: '', TYPESCRIPT_NATIVE_LSP_TSDK: tsdk } }), /TypeScript 7 or newer/);
});

test('TypeScript 6 whose package ships no tsserver.js is refused with an explanation', () => {
	const root = tempDir();
	writeFakeTypescript(path.join(root, 'node_modules', 'typescript'), '6.0.2');
	writeFakeLanguageServer(path.join(root, 'node_modules'));
	assert.throws(() => resolveServer({ projectDir: root, ...hermetic }), /tsserver\.js/);
});

test('TypeScript 6 without any typescript-language-server is an error', () => {
	const root = tempDir();
	writeFakeTypescript(path.join(root, 'node_modules', 'typescript'), '6.0.3', { tsserver: true });
	assert.throws(() => resolveServer({ projectDir: root, ...hermetic, execPath: noNode }), /needs typescript-language-server, which is not installed/);
});

test('typescript-language-server above the lockfile root is not used', () => {
	const outer = tempDir();
	writeFakeLanguageServer(path.join(outer, 'node_modules'));
	const inner = path.join(outer, 'project');
	fs.writeFileSync(path.join(fs.mkdirSync(inner, { recursive: true }) ?? inner, 'package-lock.json'), '');
	writeFakeTypescript(path.join(inner, 'node_modules', 'typescript'), '6.0.3', { tsserver: true });
	assert.throws(() => resolveServer({ projectDir: inner, ...hermetic }), /not installed/);
});

test('a global TypeScript 7 under a global npm root is used when the project has none', () => {
	const root = tempDir();
	const globalRoot = path.join(root, 'global', 'lib', 'node_modules');
	writeFakeTypescript(path.join(globalRoot, 'typescript'), '7.0.2');
	const plan = resolveServer({ projectDir: path.join(root, 'project'), env: { PATH: '' }, globalRoots: [globalRoot] });
	assert.equal(plan.args[0], path.join(globalRoot, 'typescript', 'lib', 'tsc.js'));
	assert.match(plan.reason, /global npm root/);
});

test('a global typescript-language-server under a global npm root serves TypeScript 6 projects', () => {
	const root = tempDir();
	writeFakeTypescript(path.join(root, 'node_modules', 'typescript'), '6.0.3', { tsserver: true });
	const globalRoot = path.join(root, 'global', 'node_modules');
	const entry = writeFakeLanguageServer(globalRoot);
	const plan = resolveServer({ projectDir: root, env: { PATH: '' }, globalRoots: [globalRoot] });
	assert.equal(plan.args[0], entry);
	assert.match(plan.reason, /global typescript-language-server/);
});

test('nothing installed anywhere is an error naming what was tried', () => {
	const root = tempDir();
	assert.throws(() => resolveServer({ projectDir: root, ...hermetic, execPath: noNode }), /no tsc\/tsgo 7\+ on PATH/);
});

test('tsc 7 on PATH is used when the project has no TypeScript', { skip: 'win32' === platform && 'PATH probing is POSIX only' }, () => {
	const root = tempDir();
	const binDir = path.join(root, 'bin');
	fs.mkdirSync(binDir);
	const fakeTsc = path.join(binDir, 'tsc');
	fs.writeFileSync(fakeTsc, '#!/bin/sh\necho "Version 7.0.2"\n');
	fs.chmodSync(fakeTsc, 0o755);
	const plan = resolveServer({ projectDir: root, env: { PATH: binDir }, globalRoots: [] });
	assert.equal(plan.command, fakeTsc);
	assert.deepEqual(plan.args, ['--lsp', '--stdio']);
	assert.match(plan.reason, /tsc 7\.0\.2 on PATH/);
});

test('tsc 6 on PATH is skipped', { skip: 'win32' === platform && 'PATH probing is POSIX only' }, () => {
	const root = tempDir();
	const binDir = path.join(root, 'bin');
	fs.mkdirSync(binDir);
	const fakeTsc = path.join(binDir, 'tsc');
	fs.writeFileSync(fakeTsc, '#!/bin/sh\necho "Version 6.0.3"\n');
	fs.chmodSync(fakeTsc, 0o755);
	assert.throws(() => resolveServer({ projectDir: root, env: { PATH: binDir }, globalRoots: [] }), ResolveError);
});

test('on Windows nothing on PATH is probed or run through a shell', () => {
	const root = tempDir();
	const binDir = path.join(root, 'bin');
	fs.mkdirSync(binDir);
	fs.writeFileSync(path.join(binDir, 'tsc.cmd'), '@echo Version 7.0.2\r\n');
	assert.throws(() => resolveServer({ projectDir: root, env: { PATH: binDir, PATHEXT: '.EXE;.CMD' }, platform: 'win32', globalRoots: [] }), ResolveError);
});
