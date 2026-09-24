# Changelog

## 0.1.0

Initial release.

- Runs TypeScript 7's native language server (`tsc --lsp --stdio`) for projects on TypeScript 7 or newer.
- Falls back to typescript-language-server for projects on TypeScript 6 or older, and checks up front that it will find a usable TypeScript.
- Bridges the native server's pull diagnostics to the push notifications Claude Code listens for, so type errors reach the conversation after edits on TypeScript 7 as they do on TypeScript 6. Interim until upstream closes the gap; `TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS=0` disables it.
- Resolves every typescript package installed under `node_modules` by its package name, so a hoisted TypeScript 7 alias next to a TypeScript 6 API shim is picked up under any package manager.
- Falls back to a global TypeScript under the npm root, or on macOS and Linux to `tsc` or `tsgo` on PATH, when the project has no TypeScript. Nothing is run through a shell.
- `TYPESCRIPT_NATIVE_LSP_TSDK` overrides resolution with an explicit TypeScript 7 package directory; `TYPESCRIPT_NATIVE_LSP_GLOBAL_ROOTS` overrides where global packages are looked for.
- `node scripts/launch.mjs --resolve` prints the resolved command for troubleshooting.
