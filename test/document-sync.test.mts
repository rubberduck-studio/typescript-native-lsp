/**
 * Behavioural contract for files changed outside the client. Claude Code tells
 * the server only about files its own Edit and Write tools touch; shell
 * commands, git, formatters and codegen change files silently. Answers must
 * still match the files on disk, for every supported TypeScript version.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Location, LocationLink } from 'vscode-languageserver-protocol';
import { startSession, uriOf, diagnosticsFor, claudeCodeClient, hoverText, type Session } from './helpers/lsp-session.mts';
import { missingFixture, tempProject as project, writeSource as write, sourcePath as src } from './helpers/project.mts';

async function definitionFiles(session: Session, file: string, line: number, character: number): Promise<string[]> {
	const { result } = await session.request('textDocument/definition', { textDocument: { uri: uriOf(file) }, position: { line, character } });
	return [result ?? []].flat().filter(isLocation).map(location => fileURLToPath('uri' in location ? location.uri : location.targetUri));
}

function isLocation(value: unknown): value is Location | LocationLink {
	return 'object' === typeof value && null !== value && ('uri' in value || 'targetUri' in value);
}

function settle(ms = 1000): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

for (const engine of ['ts7', 'ts6']) {
	const skip = missingFixture(engine);

	test(`${engine}: a file rewritten on disk after the client opened it is answered from disk`, { skip }, async () => {
		const root = project(engine, { 'other.ts': 'export const other = 2;\n' });
		const session = startSession(root);
		try {
			await session.initialize();
			session.openFile(src(root, 'other.ts'));
			assert.match(await hoverText(session, src(root, 'other.ts'), 0, 14), /other: 2/);
			write(root, 'other.ts', 'export const other = 5;\n');
			await settle();
			assert.match(await hoverText(session, src(root, 'other.ts'), 0, 14), /other: 5/);
		} finally {
			await session.close();
		}
	});

	test(`${engine}: a file deleted on disk after the client opened it leaves the program`, { skip }, async () => {
		const root = project(engine, { 'a.ts': 'export class Thing { private sequence = 0; }\n', 'b.ts': 'export const b = 1;\n' });
		const session = startSession(root);
		try {
			await session.initialize();
			session.openFile(src(root, 'a.ts'));
			await hoverText(session, src(root, 'a.ts'), 0, 14);
			fs.renameSync(src(root, 'a.ts'), src(root, 'c.ts'));
			write(root, 'c.ts', 'export class Activity { private sequence = 0; }\n');
			const b = write(root, 'b.ts', 'import { Thing } from "./a.js";\nexport const t = Thing;\n');
			await settle();
			session.openFile(b);
			const targets = await definitionFiles(session, b, 0, 10);
			assert.ok(false === targets.some(target => target.endsWith(`${path.sep}a.ts`)), `definition points into the deleted file: ${targets.join(', ')}`);
		} finally {
			await session.close();
		}
	});

	test(`${engine}: a file the client edits again after it was deleted and recreated is served with the edit`, { skip }, async () => {
		const root = project(engine, { 'a.ts': 'export const a = 1;\n' });
		const session = startSession(root);
		try {
			await session.initialize();
			session.openFile(src(root, 'a.ts'));
			await hoverText(session, src(root, 'a.ts'), 0, 14);
			fs.rmSync(src(root, 'a.ts'));
			await settle();
			await hoverText(session, src(root, 'a.ts'), 0, 14);
			const text = 'export const a = 7;\n';
			write(root, 'a.ts', text);
			session.changeFile(src(root, 'a.ts'), 2, text);
			assert.match(await hoverText(session, src(root, 'a.ts'), 0, 14), /a: 7/);
		} finally {
			await session.close();
		}
	});
}

for (const engine of ['ts7', 'ts6']) {
	const skip = missingFixture(engine);

	test(`${engine}: diagnostics after a shell rename report no conflict with the renamed-away file`, { skip }, async () => {
		const root = project(engine, {
			'a.ts': 'export class Thing { private sequence = 0; }\n',
			'user.ts': 'import { Thing } from "./a.js";\nexport function use(value: Thing): Thing {\n\treturn value;\n}\n',
		});
		const session = startSession(root);
		try {
			await session.initialize();
			session.openFile(src(root, 'a.ts'));
			session.openFile(src(root, 'user.ts'));
			await hoverText(session, src(root, 'user.ts'), 0, 10);
			fs.renameSync(src(root, 'a.ts'), src(root, 'c.ts'));
			write(root, 'c.ts', 'export class Activity { private sequence = 0; }\n');
			write(root, 'user.ts', 'import { Activity } from "./c.js";\nexport function use(value: Activity): Activity {\n\treturn value;\n}\n');
			await settle();
			const text = 'import { Activity } from "./c.js";\nimport { use } from "./user.js";\nexport const used = use(new Activity());\n';
			const main = write(root, 'main.ts', text);
			await hoverText(session, src(root, 'user.ts'), 0, 10);
			session.openFile(main, text);
			await session.waitForNotification(diagnosticsFor(main), { timeoutMs: 8000 });
			await settle(500);
			const last = session.notifications.filter(diagnosticsFor(main)).at(-1);
			assert.ok(undefined !== last, 'no diagnostics published for main.ts');
			assert.deepEqual(last.params.diagnostics.map(d => d.code), [], JSON.stringify(last.params.diagnostics.map(d => d.message)));
		} finally {
			await session.close();
		}
	});
}

for (const engine of ['ts7', 'ts6']) {
	const skip = missingFixture(engine);

	test(`${engine}: a file that returns to disk after it was deleted is served again without a client edit`, { skip }, async () => {
		const root = project(engine, { 'a.ts': 'export const a = 1;\n' });
		const session = startSession(root);
		try {
			await session.initialize();
			session.openFile(src(root, 'a.ts'));
			assert.match(await hoverText(session, src(root, 'a.ts'), 0, 14), /a: 1/);
			fs.rmSync(src(root, 'a.ts'));
			await settle();
			await hoverText(session, src(root, 'a.ts'), 0, 14);
			write(root, 'a.ts', 'export const a = 8;\n');
			await settle();
			assert.match(await hoverText(session, src(root, 'a.ts'), 0, 14), /a: 8/);
		} finally {
			await session.close();
		}
	});
}

/** Claude Code 2.1.288 began advertising file watching without ever sending events; advertised capabilities must not switch document sync off. */
test('a client that advertises file watching, even with dynamic registration, still gets open documents synced from disk', { skip: missingFixture('ts7') }, async () => {
	const root = project('ts7', { 'other.ts': 'export const other = 2;\n' });
	const session = startSession(root, { capabilities: { ...claudeCodeClient.capabilities, workspace: { ...claudeCodeClient.capabilities.workspace, didChangeWatchedFiles: { dynamicRegistration: true } } } });
	try {
		await session.initialize();
		session.openFile(src(root, 'other.ts'));
		assert.match(await hoverText(session, src(root, 'other.ts'), 0, 14), /other: 2/);
		write(root, 'other.ts', 'export const other = 5;\n');
		await settle();
		assert.match(await hoverText(session, src(root, 'other.ts'), 0, 14), /other: 5/);
	} finally {
		await session.close();
	}
});
