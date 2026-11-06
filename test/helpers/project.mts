import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helpers = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(helpers, '..', 'fixtures');
const tempDirs: string[] = [];
after(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
});

/** Whether `npm run fixtures` has installed the fixture's TypeScript; tests skip with the returned reason when it has not. */
export function missingFixture(engine: string): false | string {
	return false === fs.existsSync(path.join(fixtures, engine, 'node_modules')) && 'run npm run fixtures';
}

/**
 * A throwaway strict TypeScript project under the OS temp directory, borrowing a
 * fixture's node_modules, so a test can change its files freely. Files are
 * named relative to its src directory; it is removed when the test file ends.
 */
export function tempProject(engine: string, files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `typescript-native-lsp-${engine}-`));
	tempDirs.push(root);
	fs.symlinkSync(path.join(fixtures, engine, 'node_modules'), path.join(root, 'node_modules'), 'junction');
	fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
	fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', target: 'es2022', moduleResolution: 'bundler', noEmit: true }, include: ['src'] }));
	for (const [name, text] of Object.entries(files)) {
		writeSource(root, name, text);
	}
	return root;
}

/** Writes a file under the project's src directory and returns its path. */
export function writeSource(root: string, name: string, text: string): string {
	const file = sourcePath(root, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

export function sourcePath(root: string, name: string): string {
	return path.join(root, 'src', name);
}

/**
 * A throwaway project whose "TypeScript 7" is one of the fake servers in this
 * directory: the launcher finds a typescript package without a platform binary
 * and runs its lib/tsc.js with node, which is the fake. `server` is the fake's
 * path, so a test can remove it to make a restart fail. Pass `env` to the
 * session; it keeps the launcher from finding anything on PATH.
 */
export function fakeServerProject(fake: string): { root: string; file: string; server: string; env: NodeJS.ProcessEnv } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typescript-native-lsp-fake-'));
	tempDirs.push(root);
	const pkg = path.join(root, 'node_modules', 'typescript');
	fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
	fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'typescript', version: '7.0.2' }));
	const server = path.join(pkg, 'lib', 'tsc.js');
	fs.copyFileSync(path.join(helpers, fake), server);
	fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
	return { root, file: path.join(root, 'a.ts'), server, env: { PATH: '' } };
}
