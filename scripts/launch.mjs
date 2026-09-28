#!/usr/bin/env node
/**
 * Entry point spawned by Claude Code. Deliberately plain JavaScript: it checks
 * that this Node can run the plugin's TypeScript sources, which it does by
 * stripping types (Node 22.18 and newer), and otherwise explains what is missing
 * instead of failing with a syntax error. The launcher itself is main.mts.
 */
if (!process.features.typescript) {
	process.stderr.write(`[typescript-native-lsp] Node ${process.versions.node} cannot strip TypeScript types, which this plugin needs: use Node 22.18 or newer, and do not disable type stripping (--no-experimental-strip-types in NODE_OPTIONS)\n`);
	process.exit(1);
}
await import('./main.mts');
