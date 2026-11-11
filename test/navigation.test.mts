/**
 * Behavioural contract for navigation: the first request after Claude Code opens
 * a file is answered from the whole project, not from the files that happen to
 * be open. Claude Code sends that request right after didOpen, before a server
 * may have loaded the project, and an agent cannot tell a partial answer from a
 * complete one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Location, LocationLink } from 'vscode-languageserver-protocol';
import { startSession, uriOf } from './helpers/lsp-session.mts';
import { engineEnv, missingFixture, tempProject, sourcePath } from './helpers/project.mts';

const uses = (name: string): string => `import { foo } from "./a.js";\nexport const ${name}1 = foo(1);\nexport const ${name}2 = foo(2);\n`;
const FILES = {
	'a.ts': 'export function foo(value: number): number {\n\treturn value * 2;\n}\n',
	'b.ts': uses('b'),
	'c.ts': uses('c'),
};

function filesOf(result: unknown): string[] {
	return [...new Set([result ?? []].flat().filter(isLocation).map(location => path.basename(fileURLToPath('uri' in location ? location.uri : location.targetUri))))].sort();
}

function isLocation(value: unknown): value is Location | LocationLink {
	return 'object' === typeof value && null !== value && ('uri' in value || 'targetUri' in value);
}

for (const engine of ['ts7', 'ts6', 'tsrs']) {
	const skip = missingFixture(engine);

	test(`${engine}: find-references right after opening a file finds the references in every file`, { skip }, async () => {
		const root = tempProject(engine, FILES);
		const a = sourcePath(root, 'a.ts');
		const session = startSession(root, { env: engineEnv(engine) });
		try {
			await session.initialize();
			session.openFile(a);
			const { result } = await session.request('textDocument/references', { textDocument: { uri: uriOf(a) }, position: { line: 0, character: 17 }, context: { includeDeclaration: true } });
			assert.deepEqual(filesOf(result), ['a.ts', 'b.ts', 'c.ts']);
		} finally {
			await session.close();
		}
	});

	test(`${engine}: go-to-definition right after opening a file reaches a file that is not open`, { skip }, async () => {
		const root = tempProject(engine, FILES);
		const b = sourcePath(root, 'b.ts');
		const session = startSession(root, { env: engineEnv(engine) });
		try {
			await session.initialize();
			session.openFile(b);
			const { result } = await session.request('textDocument/definition', { textDocument: { uri: uriOf(b) }, position: { line: 1, character: 20 } });
			assert.deepEqual(filesOf(result), ['a.ts']);
		} finally {
			await session.close();
		}
	});
}
