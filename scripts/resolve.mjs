/**
 * Resolves which language server to run for a project.
 *
 * TypeScript 7 (the native Go compiler) serves LSP itself via `tsc --lsp --stdio`
 * and ships no tsserver.js, so typescript-language-server cannot drive it.
 * TypeScript 6 and older have no `--lsp` mode and need typescript-language-server.
 * The right choice therefore depends on the TypeScript the project uses.
 *
 * Resolution order:
 *   1. TYPESCRIPT_NATIVE_LSP_TSDK: an explicit path to a `typescript` package
 *      directory (TypeScript 7 or newer).
 *   2. Every typescript package installed under `node_modules`, walking up from the
 *      project directory to the nearest lockfile or git root. A package counts by
 *      the name in its own package.json, not by its directory, so an alias such as
 *      `"@typescript/native": "npm:typescript@7"` is found wherever the package
 *      manager hoisted it. The highest version wins, so an aliased TypeScript 7 next
 *      to a TypeScript 6 API shim is picked up.
 *   3. Workspace packages under `packages/*` and `apps/*` of that root, same rule.
 *   4. A `typescript` package of version 7 or newer under the global npm root.
 *   5. On POSIX, `tsc` or `tsgo` on PATH when they report version 7 or newer.
 *   6. For TypeScript 6 and older: typescript-language-server, project-local, then
 *      under the global npm root, then on PATH. It locates TypeScript itself (the
 *      first `node_modules/typescript/lib` above the workspace), so the resolver
 *      only checks that this will succeed and fails early with a clear message
 *      when it will not.
 *
 * Every result is an absolute command so it can be exec'd without a PATH lookup,
 * and nothing is ever run through a shell.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const LSP_ARGS = ['--lsp', '--stdio'];
const ROOT_MARKERS = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', '.git'];
const WORKSPACE_DIRS = ['packages', 'apps'];
const SKIPPED_ENTRIES = new Set(['.bin', '.cache', '.package-lock.json', '.pnpm', '.modules.yaml', '.yarn-integrity']);
const LANGUAGE_SERVER_ENTRY = path.join('typescript-language-server', 'lib', 'cli.mjs');

export class ResolveError extends Error {}

/**
 * @param {object} options
 * @param {string} options.projectDir  directory the session is rooted at
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.arch]
 * @param {string} [options.execPath]  node binary used to run JS entry points
 * @param {string[]} [options.globalRoots]  global `node_modules` directories to search; derived from env and execPath when omitted
 * @returns {{ command: string, args: string[], native: boolean, reason: string, typescript?: { dir: string, version: string } }}
 *   `native` is true when the command is TypeScript's own language server (7 or newer).
 */
export function resolveServer({ projectDir, env = process.env, platform = process.platform, arch = process.arch, execPath = process.execPath, globalRoots }) {
	const context = { env, platform, arch, execPath, globalRoots: globalRoots ?? globalNodeModules({ env, platform, execPath }) };
	const start = path.resolve(projectDir);

	const override = env.TYPESCRIPT_NATIVE_LSP_TSDK;
	if (override) {
		const dir = path.resolve(override);
		const pkg = readPackage(dir);
		if (null === pkg || 'typescript' !== pkg.name) {
			throw new ResolveError(`TYPESCRIPT_NATIVE_LSP_TSDK is set to "${override}" but that is not a typescript package directory`);
		}
		if (majorOf(pkg.version) < 7) {
			throw new ResolveError(`TYPESCRIPT_NATIVE_LSP_TSDK points at TypeScript ${pkg.version}; the override applies to TypeScript 7 or newer, typescript-language-server locates TypeScript 6 and older itself`);
		}
		return { ...nativeCommand(dir, context), reason: `TypeScript ${pkg.version} via TYPESCRIPT_NATIVE_LSP_TSDK at ${dir}`, typescript: { dir, version: pkg.version } };
	}

	const rootDir = findRootDir(start);
	const local = findProjectTypescript(start, rootDir);
	if (null !== local) {
		return majorOf(local.pkg.version) >= 7 ? nativePlan(local, context) : languageServerPlan(local, start, rootDir, context);
	}

	const global = findGlobalTypescript(context);
	if (null !== global) {
		return nativePlan(global, context);
	}

	const onPath = findNativeOnPath(context);
	if (null !== onPath) {
		return onPath;
	}

	throw new ResolveError(`no TypeScript found in ${start} or its parents, none under a global npm root, and no tsc/tsgo 7+ on PATH`);
}

function nativePlan(found, context) {
	return { ...nativeCommand(found.dir, context), reason: `TypeScript ${found.pkg.version} via ${found.via} at ${found.dir}`, typescript: { dir: found.dir, version: found.pkg.version } };
}

/* ---------- project TypeScript ---------- */

function findRootDir(start) {
	let dir = start;
	while (true) {
		if (isRootDir(dir)) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return dir;
		}
		dir = parent;
	}
}

function findProjectTypescript(start, rootDir) {
	for (const dir of ancestors(start, rootDir)) {
		const found = bestTypescriptIn(dir);
		if (null !== found) {
			return found;
		}
	}
	return findWorkspaceTypescript(rootDir);
}

/**
 * The highest-versioned typescript package installed directly under a directory's
 * node_modules, found by the name in each package's own package.json so that
 * aliased installs count whatever directory they live in.
 */
function bestTypescriptIn(dir) {
	const nodeModules = path.join(dir, 'node_modules');
	let best = null;
	for (const entry of listEntries(nodeModules)) {
		const pkgDir = path.join(nodeModules, entry);
		const pkg = readPackage(pkgDir);
		if (null === pkg || 'typescript' !== pkg.name) {
			continue;
		}
		if (null === best || compareVersions(pkg.version, best.pkg.version) > 0) {
			best = { dir: pkgDir, pkg, via: 'typescript' === entry ? 'node_modules/typescript' : `node_modules/${entry}, an alias of typescript` };
		}
	}
	return best;
}

/** Package directory names under a node_modules, with scoped packages as `@scope/name`. */
function listEntries(nodeModules) {
	const entries = [];
	for (const name of listNames(nodeModules)) {
		if (SKIPPED_ENTRIES.has(name)) {
			continue;
		}
		if (name.startsWith('@')) {
			for (const scoped of listNames(path.join(nodeModules, name))) {
				entries.push(`${name}/${scoped}`);
			}
			continue;
		}
		entries.push(name);
	}
	return entries;
}

function listNames(dir) {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

function findWorkspaceTypescript(rootDir) {
	let best = null;
	for (const group of WORKSPACE_DIRS) {
		const groupDir = path.join(rootDir, group);
		for (const name of listDirectories(groupDir)) {
			const found = bestTypescriptIn(path.join(groupDir, name));
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

/* ---------- native (TypeScript 7+) ---------- */

function nativeCommand(pkgDir, { platform, arch, execPath }) {
	const executable = nativeExecutable(pkgDir, platform, arch);
	if (null !== executable) {
		return { command: executable, args: LSP_ARGS, native: true };
	}
	const wrapper = path.join(pkgDir, 'lib', 'tsc.js');
	if (fs.existsSync(wrapper)) {
		return { command: execPath, args: [wrapper, ...LSP_ARGS], native: true };
	}
	throw new ResolveError(`TypeScript at ${pkgDir} has neither a platform binary for ${platform}-${arch} nor lib/tsc.js`);
}

/**
 * Mirrors typescript's own lib/getExePath.js: the compiler binary lives in the
 * platform package next to the typescript package. Resolution starts from the
 * real path, because package managers that symlink packages keep the platform
 * package next to the target, not next to the link.
 */
function nativeExecutable(pkgDir, platform, arch) {
	let realDir;
	try {
		realDir = fs.realpathSync(pkgDir);
	} catch {
		return null;
	}
	const require = createRequire(path.join(realDir, 'package.json'));
	let platformPackageJson;
	try {
		platformPackageJson = require.resolve(`@typescript/typescript-${platform}-${arch}/package.json`);
	} catch {
		return null;
	}
	const executable = path.join(path.dirname(platformPackageJson), 'lib', 'win32' === platform ? 'tsc.exe' : 'tsc');
	return fs.existsSync(executable) ? executable : null;
}

function findGlobalTypescript({ globalRoots }) {
	for (const root of globalRoots) {
		const dir = path.join(root, 'typescript');
		const pkg = readPackage(dir);
		if (null !== pkg && 'typescript' === pkg.name && majorOf(pkg.version) >= 7) {
			return { dir, pkg, via: 'the global npm root' };
		}
	}
	return null;
}

/** POSIX only: a `tsc` or `tsgo` on PATH that is not an npm package, such as a Homebrew install. */
function findNativeOnPath(context) {
	if ('win32' === context.platform) {
		return null;
	}
	for (const name of ['tsc', 'tsgo']) {
		const command = whichOnPath(name, context);
		if (null === command) {
			continue;
		}
		const version = versionFromCli(command);
		if (null !== version && majorOf(version) >= 7) {
			return { command, args: LSP_ARGS, native: true, reason: `${name} ${version} on PATH at ${command}` };
		}
	}
	return null;
}

/* ---------- typescript-language-server (TypeScript <= 6) ---------- */

function languageServerPlan(found, start, rootDir, context) {
	const usable = languageServerTypescript(start);
	if (null === usable) {
		throw new ResolveError(
			`TypeScript ${found.pkg.version} at ${found.dir} needs typescript-language-server, which locates TypeScript itself as the first node_modules/typescript above ${start} that ships lib/tsserver.js, and there is none; install typescript@6 as the project's "typescript" dependency`,
		);
	}
	const server = findLanguageServer(start, rootDir, context);
	if (null === server) {
		throw new ResolveError(
			`TypeScript ${found.pkg.version} at ${found.dir} needs typescript-language-server, which is not installed in the project, under a global npm root, or on PATH`,
		);
	}
	return {
		...server,
		reason: `TypeScript ${found.pkg.version} via ${found.via} at ${found.dir}; ${server.reason}, which will use ${usable}`,
		typescript: { dir: found.dir, version: found.pkg.version },
	};
}

/** The TypeScript typescript-language-server will pick: the first node_modules/typescript/lib above the workspace, if it has tsserver.js. */
function languageServerTypescript(start) {
	const lib = findUp(start, dir => existingPath(path.join(dir, 'node_modules', 'typescript', 'lib')));
	if (null === lib) {
		return null;
	}
	return fs.existsSync(path.join(lib, 'tsserver.js')) ? path.dirname(lib) : null;
}

function findLanguageServer(start, rootDir, context) {
	for (const dir of ancestors(start, rootDir)) {
		const entry = existingPath(path.join(dir, 'node_modules', LANGUAGE_SERVER_ENTRY));
		if (null !== entry) {
			return { command: context.execPath, args: [entry, '--stdio'], native: false, reason: `project-local typescript-language-server at ${entry}` };
		}
	}
	for (const root of context.globalRoots) {
		const entry = existingPath(path.join(root, LANGUAGE_SERVER_ENTRY));
		if (null !== entry) {
			return { command: context.execPath, args: [entry, '--stdio'], native: false, reason: `global typescript-language-server at ${entry}` };
		}
	}
	if ('win32' !== context.platform) {
		const command = whichOnPath('typescript-language-server', context);
		if (null !== command) {
			return { command, args: ['--stdio'], native: false, reason: `typescript-language-server on PATH at ${command}` };
		}
	}
	return null;
}

export function globalNodeModules({ env, platform, execPath }) {
	const roots = [];
	if (env.npm_config_prefix) {
		roots.push(path.join(env.npm_config_prefix, 'win32' === platform ? 'node_modules' : path.join('lib', 'node_modules')));
	}
	if ('win32' === platform) {
		if (env.APPDATA) {
			roots.push(path.join(env.APPDATA, 'npm', 'node_modules'));
		}
		roots.push(path.join(path.dirname(execPath), 'node_modules'));
	} else {
		roots.push(path.join(path.dirname(execPath), '..', 'lib', 'node_modules'));
		roots.push('/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules');
	}
	return roots;
}

/* ---------- helpers ---------- */

/** POSIX PATH lookup for a regular executable file. */
function whichOnPath(name, { env }) {
	for (const entry of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
		const candidate = path.join(entry, name);
		if (isExecutable(candidate)) {
			return candidate;
		}
	}
	return null;
}

function versionFromCli(command) {
	const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
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

/** `start` and its parents up to and including `rootDir`. */
function* ancestors(start, rootDir) {
	let dir = start;
	while (true) {
		yield dir;
		if (dir === rootDir) {
			return;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return;
		}
		dir = parent;
	}
}

function findUp(start, probe) {
	let dir = start;
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

function existingPath(filePath) {
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

/** Subdirectories of `dir`, following symlinks, as package managers link workspace packages. */
function listDirectories(dir) {
	try {
		return fs.readdirSync(dir).filter(name => {
			try {
				return fs.statSync(path.join(dir, name)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch {
		return [];
	}
}
