/**
 * Resolves which language server to run for a project.
 *
 * TypeScript 7 (the native Go compiler) serves LSP itself via `tsc --lsp --stdio`
 * and ships no tsserver.js, so typescript-language-server cannot drive it.
 * TypeScript 6 and older have no `--lsp` mode and need typescript-language-server.
 * The right choice therefore depends on the TypeScript the project actually uses.
 *
 * Resolution order:
 *   1. TYPESCRIPT_NATIVE_LSP_TSDK: an explicit path to a `typescript` package directory.
 *   2. The TypeScript the project's own `tsc` runs, found by following
 *      `node_modules/.bin/tsc` (a symlink on POSIX, npm's shell shim on Windows).
 *      This is what makes aliased installs work, where `node_modules/typescript`
 *      is a different package than the one behind `tsc`.
 *   3. `node_modules/typescript`, walking up from the project directory to the
 *      nearest lockfile or git root.
 *   4. Workspace packages under `packages/*` and `apps/*` of that root, taking the
 *      highest version.
 *   5. `tsc` or `tsgo` on PATH when they report version 7 or newer.
 *   6. typescript-language-server, project-local, then globally installed, then on PATH.
 *
 * Every result is an absolute command so it can be exec'd without a PATH lookup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const LSP_ARGS = ['--lsp', '--stdio'];
const ROOT_MARKERS = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', '.git'];
const WORKSPACE_DIRS = ['packages', 'apps'];
const LANGUAGE_SERVER_ENTRY = path.join('typescript-language-server', 'lib', 'cli.mjs');

export class ResolveError extends Error {}

/**
 * @param {object} options
 * @param {string} options.projectDir  directory the session is rooted at
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.arch]
 * @param {string} [options.execPath]  node binary used to run JS entry points
 * @returns {{ command: string, args: string[], shell: boolean, native: boolean, reason: string, typescript?: { dir: string, version: string } }}
 *   `native` is true when the command is TypeScript's own language server (7 or newer).
 */
export function resolveServer({ projectDir, env = process.env, platform = process.platform, arch = process.arch, execPath = process.execPath }) {
	const context = { env, platform, arch, execPath };
	const override = env.TYPESCRIPT_NATIVE_LSP_TSDK;
	if (override) {
		const pkg = readPackage(override);
		if (null === pkg || 'typescript' !== pkg.name) {
			throw new ResolveError(`TYPESCRIPT_NATIVE_LSP_TSDK is set to "${override}" but that is not a typescript package directory`);
		}
		return planFor({ dir: override, pkg, via: 'TYPESCRIPT_NATIVE_LSP_TSDK' }, projectDir, context);
	}

	const local = findProjectTypescript(projectDir);
	if (null !== local) {
		return planFor(local, projectDir, context);
	}

	const onPath = findNativeOnPath(context);
	if (null !== onPath) {
		return onPath;
	}

	const languageServer = findLanguageServer(projectDir, context);
	if (null !== languageServer) {
		return { ...languageServer, reason: `no TypeScript found in ${projectDir}; using ${languageServer.reason}` };
	}

	throw new ResolveError(
		`no TypeScript found in ${projectDir} or its parents, no tsc/tsgo 7+ on PATH, and no typescript-language-server installed`,
	);
}

function planFor(found, projectDir, context) {
	const major = majorOf(found.pkg.version);
	const typescript = { dir: found.dir, version: found.pkg.version };
	if (major >= 7) {
		return { ...nativeCommand(found.dir, context), reason: `TypeScript ${found.pkg.version} via ${found.via} at ${found.dir}`, typescript };
	}
	const languageServer = findLanguageServer(projectDir, context);
	if (null === languageServer) {
		throw new ResolveError(
			`TypeScript ${found.pkg.version} at ${found.dir} needs typescript-language-server, which is not installed in the project, globally, or on PATH`,
		);
	}
	if (false === fs.existsSync(path.join(found.dir, 'lib', 'tsserver.js'))) {
		process.stderr.write(
			`[typescript-native-lsp] warning: TypeScript ${found.pkg.version} at ${found.dir} has no lib/tsserver.js; typescript-language-server will not be able to use it\n`,
		);
	}
	return { ...languageServer, reason: `TypeScript ${found.pkg.version} via ${found.via} at ${found.dir}; using ${languageServer.reason}`, typescript };
}

/* ---------- project-local TypeScript ---------- */

function findProjectTypescript(projectDir) {
	let dir = path.resolve(projectDir);
	let rootDir = null;
	while (true) {
		const found = typescriptIn(dir);
		if (null !== found) {
			return found;
		}
		if (isRootDir(dir)) {
			rootDir = dir;
			break;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return findWorkspaceTypescript(rootDir ?? path.resolve(projectDir));
}

function typescriptIn(dir) {
	const nodeModules = path.join(dir, 'node_modules');
	const binTarget = resolveBinTarget(path.join(nodeModules, '.bin', 'tsc'));
	if (null !== binTarget) {
		const pkg = readPackage(binTarget);
		if (null !== pkg && 'typescript' === pkg.name) {
			return { dir: binTarget, pkg, via: 'node_modules/.bin/tsc' };
		}
	}
	const direct = path.join(nodeModules, 'typescript');
	const pkg = readPackage(direct);
	if (null !== pkg && 'typescript' === pkg.name) {
		return { dir: direct, pkg, via: 'node_modules/typescript' };
	}
	return null;
}

function findWorkspaceTypescript(rootDir) {
	let best = null;
	for (const group of WORKSPACE_DIRS) {
		const groupDir = path.join(rootDir, group);
		for (const name of listDirectories(groupDir)) {
			const found = typescriptIn(path.join(groupDir, name));
			if (null === found) {
				continue;
			}
			if (null === best || compareVersions(found.pkg.version, best.pkg.version) > 0) {
				best = { ...found, via: `${found.via} of workspace package ${group}/${name}` };
			}
		}
	}
	return best;
}

/**
 * Follows `node_modules/.bin/tsc` to the package that owns it. npm links a symlink
 * on POSIX and writes a shell shim on Windows, which references the target as
 * "$basedir/../<package>/bin/tsc".
 */
function resolveBinTarget(binPath) {
	let stat;
	try {
		stat = fs.lstatSync(binPath);
	} catch {
		return null;
	}
	if (stat.isSymbolicLink()) {
		try {
			return packageDirOf(fs.realpathSync(binPath));
		} catch {
			return null;
		}
	}
	if (false === stat.isFile()) {
		return null;
	}
	const text = fs.readFileSync(binPath, 'utf8');
	for (const match of text.matchAll(/"\$basedir\/([^"]+)"/g)) {
		if ('node' === match[1]) {
			continue;
		}
		return packageDirOf(path.resolve(path.dirname(binPath), match[1]));
	}
	return null;
}

function packageDirOf(filePath) {
	let dir = path.dirname(filePath);
	while (true) {
		if (fs.existsSync(path.join(dir, 'package.json'))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir || 'node_modules' === path.basename(dir)) {
			return null;
		}
		dir = parent;
	}
}

/* ---------- native (TypeScript 7+) ---------- */

function nativeCommand(pkgDir, { platform, arch, execPath }) {
	const executable = nativeExecutable(pkgDir, platform, arch);
	if (null !== executable) {
		return { command: executable, args: LSP_ARGS, shell: false, native: true };
	}
	const wrapper = path.join(pkgDir, 'lib', 'tsc.js');
	if (fs.existsSync(wrapper)) {
		return { command: execPath, args: [wrapper, ...LSP_ARGS], shell: false, native: true };
	}
	throw new ResolveError(`TypeScript at ${pkgDir} has neither a platform binary for ${platform}-${arch} nor lib/tsc.js`);
}

/**
 * Mirrors typescript's own lib/getExePath.js: the compiler binary lives in the
 * platform package next to the typescript package.
 */
function nativeExecutable(pkgDir, platform, arch) {
	const require = createRequire(path.join(pkgDir, 'package.json'));
	let platformPackageJson;
	try {
		platformPackageJson = require.resolve(`@typescript/typescript-${platform}-${arch}/package.json`);
	} catch {
		return null;
	}
	const executable = path.join(path.dirname(platformPackageJson), 'lib', 'win32' === platform ? 'tsc.exe' : 'tsc');
	return fs.existsSync(executable) ? executable : null;
}

function findNativeOnPath(context) {
	for (const name of ['tsc', 'tsgo']) {
		const found = whichOnPath(name, context);
		if (null === found) {
			continue;
		}
		const version = versionFromCli(found);
		if (null === version) {
			continue;
		}
		if (majorOf(version) >= 7) {
			return { command: found.command, args: LSP_ARGS, shell: found.shell, native: true, reason: `${name} ${version} on PATH at ${found.command}` };
		}
	}
	return null;
}

/* ---------- typescript-language-server (TypeScript <= 6) ---------- */

function findLanguageServer(projectDir, context) {
	const local = findUp(path.resolve(projectDir), dir => existingFile(path.join(dir, 'node_modules', LANGUAGE_SERVER_ENTRY)));
	if (null !== local) {
		return { command: context.execPath, args: [local, '--stdio'], shell: false, native: false, reason: `project-local typescript-language-server at ${local}` };
	}
	for (const root of globalNodeModules(context)) {
		const entry = existingFile(path.join(root, LANGUAGE_SERVER_ENTRY));
		if (null !== entry) {
			return { command: context.execPath, args: [entry, '--stdio'], shell: false, native: false, reason: `global typescript-language-server at ${entry}` };
		}
	}
	const onPath = whichOnPath('typescript-language-server', context);
	if (null !== onPath) {
		return { command: onPath.command, args: ['--stdio'], shell: onPath.shell, native: false, reason: `typescript-language-server on PATH at ${onPath.command}` };
	}
	return null;
}

function globalNodeModules({ env, platform, execPath }) {
	const roots = [];
	if ('win32' === platform) {
		if (env.APPDATA) {
			roots.push(path.join(env.APPDATA, 'npm', 'node_modules'));
		}
		roots.push(path.join(path.dirname(execPath), 'node_modules'));
	} else {
		roots.push(path.join(path.dirname(execPath), '..', 'lib', 'node_modules'));
		roots.push('/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules');
	}
	if (env.npm_config_prefix) {
		roots.unshift(path.join(env.npm_config_prefix, 'win32' === platform ? 'node_modules' : path.join('lib', 'node_modules')));
	}
	return roots;
}

/* ---------- helpers ---------- */

function whichOnPath(name, { env, platform }) {
	const entries = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
	const extensions = 'win32' === platform ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
	for (const entry of entries) {
		for (const extension of extensions) {
			const candidate = path.join(entry, name + extension.toLowerCase());
			if (false === isExecutable(candidate)) {
				continue;
			}
			const shell = 'win32' === platform && '.exe' !== extension.toLowerCase();
			return { command: candidate, shell };
		}
	}
	return null;
}

function versionFromCli({ command, shell }) {
	const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000, shell, windowsHide: true });
	if (0 !== result.status) {
		return null;
	}
	const match = /Version (\d+\.\d+\.\S+)/.exec(result.stdout ?? '');
	return null === match ? null : match[1];
}

function readPackage(dir) {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
		return 'string' === typeof pkg.name && 'string' === typeof pkg.version ? pkg : null;
	} catch {
		return null;
	}
}

function majorOf(version) {
	return Number.parseInt(version, 10);
}

function compareVersions(a, b) {
	const pa = a.split(/[.-]/).map(part => Number.parseInt(part, 10));
	const pb = b.split(/[.-]/).map(part => Number.parseInt(part, 10));
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] || 0) - (pb[i] || 0);
		if (0 !== diff) {
			return diff;
		}
	}
	return 0;
}

function isRootDir(dir) {
	return ROOT_MARKERS.some(marker => fs.existsSync(path.join(dir, marker)));
}

function findUp(startDir, probe) {
	let dir = startDir;
	while (true) {
		const hit = probe(dir);
		if (null !== hit) {
			return hit;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

function existingFile(filePath) {
	return fs.existsSync(filePath) ? filePath : null;
}

function isExecutable(filePath) {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function listDirectories(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
	} catch {
		return [];
	}
}
