/**
 * Behavioural contract for diagnostics, independent of how they are produced:
 * a client that only understands pushed diagnostics must receive them for the
 * files it opens and edits, on every supported TypeScript version.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSession, uriOf } from './helpers/lsp-session.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXED = 'import { double } from "./index.js";\nexport const right: number = double(2);\n';

function fixture(name) {
	return path.join(fixtures, name);
}

function installed(name) {
	return fs.existsSync(path.join(fixture(name), 'node_modules'));
}

function diagnosticsFor(uri) {
	return message => 'textDocument/publishDiagnostics' === message.method && message.params.uri.toLowerCase() === uri.toLowerCase();
}

for (const name of ['ts7', 'ts6']) {
	test(`${name}: opening a file with a type error pushes its diagnostics to the client`, { skip: false === installed(name) && 'run npm run fixtures' }, async () => {
		const file = path.join(fixture(name), 'error.ts');
		const session = startSession(fixture(name));
		try {
			await session.initialize();
			session.openFile(file);
			const published = await session.waitForNotification(diagnosticsFor(uriOf(file)));
			const codes = published.params.diagnostics.map(d => d.code);
			assert.ok(codes.includes(2322), `expected TS2322 among ${JSON.stringify(codes)}`);
		} finally {
			session.close();
		}
	});

	test(`${name}: fixing the file pushes an empty diagnostics set`, { skip: false === installed(name) && 'run npm run fixtures' }, async () => {
		const file = path.join(fixture(name), 'error.ts');
		const session = startSession(fixture(name));
		try {
			await session.initialize();
			session.openFile(file);
			await session.waitForNotification(diagnosticsFor(uriOf(file)));
			session.changeFile(file, 2, FIXED);
			const cleared = await session.waitForNotification(message => diagnosticsFor(uriOf(file))(message) && 0 === message.params.diagnostics.length);
			assert.deepEqual(cleared.params.diagnostics, []);
		} finally {
			session.close();
		}
	});
}
