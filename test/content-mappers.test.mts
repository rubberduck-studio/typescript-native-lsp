/**
 * The content_mappers option (TYPESCRIPT_NATIVE_LSP_CONTENT_MAPPERS): the native
 * server is told in `initialize`, as a boolean and on every start, that it may
 * run the content mappers a tsconfig.json declares; with the option off the
 * client's initializationOptions reach it unchanged.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSession, uriOf, type Session } from './helpers/lsp-session.mts';
import { engineEnv, fakeServerProject, missingFixture } from './helpers/project.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const OFF = { TYPESCRIPT_NATIVE_LSP_CONTENT_MAPPERS: 'false' };

/** The initializationOptions the fake server reports in its hover answer. */
async function serverOptions(session: Session, file: string): Promise<Record<string, unknown>> {
	const response = await session.request('textDocument/hover', { textDocument: { uri: uriOf(file) }, position: { line: 0, character: 0 } });
	assert.equal(response.error, undefined, JSON.stringify(response));
	const match = /fake server \d+ (\{.*\})"/.exec(JSON.stringify(response.result).replaceAll('\\"', '"'));
	assert.ok(null !== match, JSON.stringify(response.result));
	const state: unknown = JSON.parse(match[1] ?? '{}');
	assert.ok('object' === typeof state && null !== state && 'initializationOptions' in state, JSON.stringify(state));
	const options: unknown = state.initializationOptions;
	assert.ok('object' === typeof options && null !== options, JSON.stringify(state));
	return { ...options };
}

test('by default the native server gets runExternalCode: true next to the plugin\'s own options, also after idle shutdown', async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env: { ...env, TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS: '1', TYPESCRIPT_NATIVE_LSP_DEBUG: '1' } });
	try {
		await session.initialize();
		session.openFile(file);
		const first = await serverOptions(session, file);
		assert.equal(first.runExternalCode, true);
		assert.ok('tsserver' in first, JSON.stringify(first));
		await session.waitForLog('server stopped');
		assert.equal((await serverOptions(session, file)).runExternalCode, true);
		assert.match(session.stderr, /content mappers on/);
	} finally {
		await session.close();
	}
});

test('with the option off, initializationOptions reach the server unchanged', async () => {
	const { root, file, env } = fakeServerProject('fake-server.mjs');
	const session = startSession(root, { env: { ...env, ...OFF } });
	try {
		await session.initialize();
		session.openFile(file);
		assert.equal('runExternalCode' in (await serverOptions(session, file)), false);
		assert.doesNotMatch(session.stderr, /content mappers on/);
	} finally {
		await session.close();
	}
});

/** The version of TypeScript (or of the TypeScript that tsrs ports) a fixture installed. */
function fixtureVersion(engine: string): string {
	const pkg = path.join(here, 'fixtures', engine, 'node_modules', 'tsrs' === engine ? 'tsrs' : 'typescript', 'package.json');
	return fs.existsSync(pkg) ? JSON.parse(fs.readFileSync(pkg, 'utf8')).version : '';
}

/** Whether a version is TypeScript 7.1 or newer, the first with content mappers. */
function hasContentMappers(version: string): boolean {
	const [major = 0, minor = 0] = version.split('.').map(Number);
	return major > 7 || (7 === major && minor >= 1);
}

/**
 * A project whose tsconfig.json maps `.greeting` files with test/helpers/content-mapper.mjs,
 * installed in the project's own node_modules: TypeScript loads a mapper only from inside
 * the workspace. The fixture's packages are linked in beside it.
 */
function mapperProject(engine: string): { project: string; file: string } {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), `typescript-native-lsp-mapper-${engine}-`));
	after(() => fs.rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
	const fixtureModules = path.join(here, 'fixtures', engine, 'node_modules');
	for (const entry of fs.readdirSync(fixtureModules)) {
		fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
		fs.symlinkSync(path.join(fixtureModules, entry), path.join(project, 'node_modules', entry), 'junction');
	}
	const mapper = path.join(project, 'node_modules', 'greeting-mapper');
	fs.mkdirSync(mapper);
	fs.writeFileSync(path.join(mapper, 'package.json'), JSON.stringify({ name: 'greeting-mapper', version: '1.0.0', type: 'module', typescript: { contentMapper: { exec: ['node', 'main.mjs'] } } }));
	fs.copyFileSync(path.join(here, 'helpers', 'content-mapper.mjs'), path.join(mapper, 'main.mjs'));
	fs.mkdirSync(path.join(project, 'src'));
	fs.writeFileSync(path.join(project, 'package-lock.json'), '{}');
	fs.writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', noEmit: true }, include: ['src'], contentMappers: [{ package: 'greeting-mapper', extensions: ['.greeting'] }] }));
	fs.writeFileSync(path.join(project, 'src', 'x.greeting'), 'hi\n');
	const file = path.join(project, 'src', 'index.ts');
	fs.writeFileSync(file, 'import { value } from "./x.greeting";\nexport const greeting = value;\n');
	return { project, file };
}

for (const engine of ['ts7', 'tsrs']) {
	const skip = missingFixture(engine) || (false === hasContentMappers(fixtureVersion(engine)) && `content mappers need TypeScript 7.1; the ${engine} fixture has ${fixtureVersion(engine)}`);

	test(`${engine}: the server runs the project's content mappers unless the option is off`, { skip }, async () => {
		const { project, file } = mapperProject(engine);
		for (const on of [false, true]) {
			const session = startSession(project, { env: { ...engineEnv(engine), ...(on ? {} : OFF) } });
			try {
				await session.initialize();
				session.openFile(file);
				const hover = await session.request('textDocument/hover', { textDocument: { uri: uriOf(file) }, position: { line: 1, character: 25 } });
				assert.equal(JSON.stringify(hover.result ?? null).includes('\\"hi\\"'), on, JSON.stringify(hover));
			} finally {
				await session.close();
			}
		}
	});
}
