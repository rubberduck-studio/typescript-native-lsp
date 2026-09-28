# Changelog

## 1.1.2

- The plugin is now written in TypeScript that Node runs directly by stripping the types, with no build step, and type-checked in CI. It needs Node 22.18 or newer; on an older Node, or with type stripping disabled, the launcher says so instead of failing with a syntax error.

## 1.1.1

- Starts the server faster. Resolving TypeScript read the package.json of every package in node_modules; it now reads only packages that ship `lib/tsc.js`, which cut the launcher's startup on a monorepo with about 1,100 packages from around 80 ms to about 30 ms warm. Claude Code rejects requests made while a server is still starting instead of queueing them, so a shorter start makes those errors rarer.

## 1.1.0

- Keeps the server in line with disk for files changed outside Claude Code. Claude Code only reports its own edits and never closes documents, so after shell commands, git, formatters or codegen, answers came from stale file contents, and renamed or deleted files lingered in the program with false diagnostics against them. Before every request the proxy now sends changed files' current content, closes deleted ones and reopens restored ones, for TypeScript 7 and for TypeScript 6 and older. `TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC=0` disables it.
- The launcher now proxies TypeScript 6 and older too, since document sync applies to every server.

## 1.0.0

Initial release.

- Runs TypeScript 7's native language server (`tsc --lsp --stdio`) for projects on TypeScript 7 or newer.
- Falls back to typescript-language-server for projects on TypeScript 6 or older, and checks up front that it will find a usable TypeScript.
- Bridges the native server's pull diagnostics to the push notifications Claude Code listens for, so type errors reach the conversation after edits on TypeScript 7 as they do on TypeScript 6. Interim until upstream closes the gap; `TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS=0` disables it.
- Resolves every typescript package installed under `node_modules` by its package name, so a hoisted TypeScript 7 alias next to a TypeScript 6 API shim is picked up under any package manager.
- Falls back to a global TypeScript under the npm root, or on macOS and Linux to `tsc` or `tsgo` on PATH, when the project has no TypeScript. Nothing is run through a shell.
- `TYPESCRIPT_NATIVE_LSP_TSDK` overrides resolution with an explicit TypeScript 7 package directory; `TYPESCRIPT_NATIVE_LSP_GLOBAL_ROOTS` overrides where global packages are looked for.
- `node scripts/launch.mjs --resolve` prints the resolved command for troubleshooting.
