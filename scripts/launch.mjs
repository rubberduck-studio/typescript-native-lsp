#!/usr/bin/env node
/**
 * Entry point spawned by Claude Code. Resolves the right language server for
 * the project and hands the stdio pipes over to it.
 *
 * For the native server the launcher stays in the middle as a diagnostics bridge
 * (see diagnostics-bridge.mjs), unless TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS=0 opts
 * out. Otherwise, on POSIX it replaces itself with the server (execve), so Claude
 * Code talks to the server directly; on Windows, or where execve is unavailable,
 * it stays as a thin parent that forwards signals and exits with the server's
 * status.
 *
 * stdout carries the LSP protocol, so every message from the launcher goes to
 * stderr. `--resolve` prints the resolved command as JSON and exits, for
 * troubleshooting from a shell.
 */
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { resolveServer, ResolveError } from './resolve.mjs';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const KILL_GRACE_MS = 2000;

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const resolveOnly = process.argv.includes('--resolve');
const bridgeDiagnostics = '0' !== process.env.TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS;

const globalRoots = process.env.TYPESCRIPT_NATIVE_LSP_GLOBAL_ROOTS?.split(path.delimiter).filter(Boolean);

let plan;
try {
	plan = resolveServer({ projectDir, globalRoots });
} catch (error) {
	if (false === error instanceof ResolveError) {
		throw error;
	}
	log(error.message);
	log('set TYPESCRIPT_NATIVE_LSP_TSDK to a typescript package directory, install typescript in the project, or install typescript-language-server for TypeScript 6 and older');
	process.exit(1);
}

const useBridge = plan.native && bridgeDiagnostics;

if (resolveOnly) {
	process.stdout.write(JSON.stringify({ projectDir, ...plan, diagnosticsBridge: useBridge }, null, 2) + '\n');
	process.exit(0);
}

log(`project dir ${projectDir}${projectDir === process.cwd() ? '' : ` (cwd ${process.cwd()})`}`);
log(plan.reason);
log(`launching ${plan.command} ${plan.args.join(' ')}`);

if (useBridge) {
	const { runBridge } = await import('./diagnostics-bridge.mjs');
	runBridge({ command: plan.command, args: plan.args, log, debug: '1' === process.env.TYPESCRIPT_NATIVE_LSP_DEBUG });
} else {
	launchDirectly(plan);
}

function launchDirectly({ command, args }) {
	if ('function' === typeof process.execve && 'win32' !== process.platform) {
		try {
			process.execve(command, [command, ...args], process.env);
		} catch (error) {
			log(`execve failed (${error.message}); spawning instead`);
		}
	}

	const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
	for (const signal of SIGNALS) {
		process.on(signal, () => {
			child.kill(signal);
			setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
		});
	}
	child.on('error', error => {
		log(`failed to start ${command}: ${error.message}`);
		process.exitCode = 1;
	});
	child.on('close', (code, signal) => {
		if (null !== signal) {
			log(`server exited on ${signal}`);
		}
		process.exitCode = null !== signal ? 128 + (os.constants.signals[signal] ?? 0) : code ?? 1;
	});
}

function log(message) {
	process.stderr.write(`[typescript-native-lsp] ${message}\n`);
}
