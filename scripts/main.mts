/**
 * Resolves the right language server for the project and hands the stdio pipes
 * over to it. Started by launch.mjs.
 *
 * By default the launcher stays in the middle as a proxy (see proxy.mts) that
 * stops the server when idle and starts it again on demand, and runs the
 * features that work around gaps in Claude Code's LSP client: document sync for
 * every server and the diagnostics bridge for the native server. When idle
 * shutdown and both features are off, on POSIX it replaces itself with the
 * server (execve), so Claude Code talks to the server directly; on Windows, or
 * where execve is unavailable, it stays as a thin parent that forwards signals
 * and exits with the server's status.
 *
 * Users set these through the plugin options in .claude-plugin/plugin.json,
 * which .lsp.json hands to the launcher as environment variables:
 * TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS (idle_shutdown_seconds, default 600, 0 turns
 * it off), TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC (document_sync) and
 * TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS (diagnostics_bridge), the switches taking
 * true or false (or 1 or 0), on by default.
 *
 * stdout carries the LSP protocol, so every message from the launcher goes to
 * stderr. `--resolve` prints the resolved command as JSON and exits, for
 * troubleshooting from a shell.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveServer, ResolveError, type Plan } from './resolve.mts';
import type { FeatureFactory } from './proxy.mts';
import { exitStatus } from './server.mts';

type FeatureName = 'document-sync' | 'diagnostics-bridge';

const DEFAULT_IDLE_SECONDS = 600;
const KILL_GRACE_MS = 2000;
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const resolveOnly = process.argv.includes('--resolve');
const syncDocuments = readSwitch('TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC');
const bridgeDiagnostics = readSwitch('TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS');
const globalRoots = process.env.TYPESCRIPT_NATIVE_LSP_GLOBAL_ROOTS?.split(path.delimiter).filter(Boolean);
const idleSeconds = readIdleSeconds(process.env.TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS);

const plan = resolvePlan();
const features: FeatureName[] = [];
if (syncDocuments) {
	features.push('document-sync');
}
if (plan.native && bridgeDiagnostics) {
	features.push('diagnostics-bridge');
}

if (resolveOnly) {
	process.stdout.write(JSON.stringify({ projectDir, ...plan, proxyFeatures: features, idleSeconds }, null, 2) + '\n');
	process.exit(0);
}

log(`project dir ${projectDir}${projectDir === process.cwd() ? '' : ` (cwd ${process.cwd()})`}`);
log(plan.reason);
log(`launching ${plan.command} ${plan.args.join(' ')}`);

if (features.length > 0 || idleSeconds > 0) {
	const { runProxy } = await import('./proxy.mts');
	runProxy({ command: plan.command, args: plan.args, log, debug: '1' === process.env.TYPESCRIPT_NATIVE_LSP_DEBUG, idleMs: idleSeconds * 1000, features: await loadFeatures(features) });
} else {
	launchDirectly(plan);
}

function resolvePlan(): Plan {
	try {
		return resolveServer({ projectDir, globalRoots });
	} catch (error) {
		if (false === error instanceof ResolveError) {
			throw error;
		}
		log(error.message);
		log('set TYPESCRIPT_NATIVE_LSP_TSDK to a typescript package directory, install typescript in the project, or install typescript-language-server for TypeScript 6 and older');
		process.exit(1);
	}
}

/** Seconds of inactivity before the server is stopped; 0 turns idle shutdown off. Anything but 0 or a positive number means the default. */
function readIdleSeconds(value: string | undefined): number {
	if (undefined === value || '' === value.trim()) {
		return DEFAULT_IDLE_SECONDS;
	}
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return seconds;
	}
	log(`ignoring TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS=${value}: it must be 0 or a positive number of seconds; using ${DEFAULT_IDLE_SECONDS}`);
	return DEFAULT_IDLE_SECONDS;
}

/** An on/off switch, on unless set to false or 0. Anything unrecognised leaves it on. */
function readSwitch(name: string): boolean {
	const value = process.env[name]?.trim().toLowerCase();
	if (undefined === value || '' === value || 'true' === value || '1' === value) {
		return true;
	}
	if ('false' === value || '0' === value) {
		return false;
	}
	log(`ignoring ${name}=${process.env[name] ?? ''}: it must be true or false; leaving it on`);
	return true;
}

/** Loads the requested features in the order the proxy needs: the diagnostics bridge sees the client's original messages before document sync renumbers them. */
async function loadFeatures(names: FeatureName[]): Promise<FeatureFactory[]> {
	const factories: FeatureFactory[] = [];
	if (names.includes('diagnostics-bridge')) {
		factories.push((await import('./diagnostics-bridge.mts')).diagnosticsBridge);
	}
	if (names.includes('document-sync')) {
		factories.push((await import('./document-sync.mts')).documentSync);
	}
	return factories;
}

function launchDirectly({ command, args }: Plan): void {
	if ('function' === typeof process.execve && 'win32' !== process.platform) {
		try {
			process.execve(command, [command, ...args], process.env);
		} catch (error) {
			log(`execve failed (${error instanceof Error ? error.message : String(error)}); spawning instead`);
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
		process.exitCode = exitStatus(code, signal);
	});
}

function log(message: string): void {
	process.stderr.write(`[typescript-native-lsp] ${message}\n`);
}
