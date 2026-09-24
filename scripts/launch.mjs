#!/usr/bin/env node
/**
 * Entry point spawned by Claude Code. Resolves the right language server for
 * the project and hands the stdio pipes over to it.
 *
 * On POSIX the launcher replaces itself with the server (execve), so Claude Code
 * talks to the server directly and the process it tracks is the real one. On
 * Windows, or where execve is unavailable, it stays as a thin parent that
 * forwards signals and exits with the server's status.
 *
 * stdout carries the LSP protocol, so every message from the launcher goes to
 * stderr. `--resolve` prints the resolved command as JSON and exits, for
 * troubleshooting from a shell.
 */
import { spawn } from 'node:child_process';
import { resolveServer, ResolveError } from './resolve.mjs';

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const resolveOnly = process.argv.includes('--resolve');

let plan;
try {
	plan = resolveServer({ projectDir });
} catch (error) {
	if (false === error instanceof ResolveError) {
		throw error;
	}
	log(error.message);
	log('set TYPESCRIPT_NATIVE_LSP_TSDK to a typescript package directory, install typescript in the project, or install typescript-language-server for TypeScript 6 and older');
	process.exit(1);
}

if (resolveOnly) {
	process.stdout.write(JSON.stringify({ projectDir, ...plan }, null, 2) + '\n');
	process.exit(0);
}

log(plan.reason);
log(`launching ${plan.command} ${plan.args.join(' ')}`);

if ('function' === typeof process.execve && 'win32' !== process.platform && false === plan.shell) {
	try {
		process.execve(plan.command, [plan.command, ...plan.args], process.env);
	} catch (error) {
		log(`execve failed (${error.message}); spawning instead`);
	}
}

const child = spawn(plan.command, plan.args, { stdio: 'inherit', shell: plan.shell, windowsHide: true });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
	process.on(signal, () => child.kill(signal));
}
child.on('error', error => {
	log(`failed to start ${plan.command}: ${error.message}`);
	process.exit(1);
});
child.on('exit', (code, signal) => {
	if (null !== signal) {
		log(`server exited on ${signal}`);
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});

function log(message) {
	process.stderr.write(`[typescript-native-lsp] ${message}\n`);
}
