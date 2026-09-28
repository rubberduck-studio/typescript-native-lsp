/**
 * Resolves the right language server for the project and hands the stdio pipes
 * over to it. Started by launch.mjs.
 *
 * By default the launcher stays in the middle as a proxy (see proxy.mts) with
 * the features that work around gaps in Claude Code's LSP client: document sync
 * for every server (TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC=0 opts out) and the
 * diagnostics bridge for the native server (TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS=0
 * opts out). With no feature active, on POSIX it replaces itself with the server
 * (execve), so Claude Code talks to the server directly; on Windows, or where
 * execve is unavailable, it stays as a thin parent that forwards signals and
 * exits with the server's status.
 *
 * stdout carries the LSP protocol, so every message from the launcher goes to
 * stderr. `--resolve` prints the resolved command as JSON and exits, for
 * troubleshooting from a shell.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveServer, ResolveError, type Plan } from './resolve.mts';
import { exitStatus, forwardSignals, type FeatureFactory } from './proxy.mts';

type FeatureName = 'document-sync' | 'diagnostics-bridge';

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const resolveOnly = process.argv.includes('--resolve');
const syncDocuments = '0' !== process.env.TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC;
const bridgeDiagnostics = '0' !== process.env.TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS;
const globalRoots = process.env.TYPESCRIPT_NATIVE_LSP_GLOBAL_ROOTS?.split(path.delimiter).filter(Boolean);

const plan = resolvePlan();
const features: FeatureName[] = [];
if (syncDocuments) {
	features.push('document-sync');
}
if (plan.native && bridgeDiagnostics) {
	features.push('diagnostics-bridge');
}

if (resolveOnly) {
	process.stdout.write(JSON.stringify({ projectDir, ...plan, proxyFeatures: features }, null, 2) + '\n');
	process.exit(0);
}

log(`project dir ${projectDir}${projectDir === process.cwd() ? '' : ` (cwd ${process.cwd()})`}`);
log(plan.reason);
log(`launching ${plan.command} ${plan.args.join(' ')}`);

if (features.length > 0) {
	const { runProxy } = await import('./proxy.mts');
	runProxy({ command: plan.command, args: plan.args, log, debug: '1' === process.env.TYPESCRIPT_NATIVE_LSP_DEBUG, features: await loadFeatures(features) });
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
	forwardSignals(child);
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
