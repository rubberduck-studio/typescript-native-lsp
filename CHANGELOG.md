# Changelog

## 2.1.0

- Runs [tsrs](https://github.com/oxc-project/tsrs), the Rust port of TypeScript 7, when `TYPESCRIPT_NATIVE_LSP_TSDK` points at it, for example `node_modules/tsrs` in a project's `.claude/settings.json` (#2). A relative path in that setting is now taken from the project directory. Diagnostics, document sync and idle shutdown work with tsrs as with TypeScript 7.
- Fixes a failed restart after idle shutdown dropping the edits Claude Code made in the meantime: the next server served stale content, and TypeScript 7 crashed on the next edit of a file it had never seen opened. Diagnostics for those edits were lost too.
- A restart now gives up on a server that does not answer within a minute instead of waiting forever, looks for the server again so an upgrade or branch switch while it was stopped is picked up, and no longer starts a server at the end of a session just to stop it.
- A server that ignores the end of its input or a termination signal is killed instead of outliving the session, and idle shutdown no longer reads the server's responses when it is turned off.
- The `document_sync` and `diagnostics_bridge` options also accept yes/no and on/off.

## 2.0.0

- Stops the server after 10 minutes without activity from Claude Code and starts it again, with the same open files, when Claude next needs it. Claude Code keeps language servers running until the session ends, and TypeScript's servers hold on to every project they loaded, several GB per session on a large repository. The first request after a stop is a cold start, about a second on a 4,700-file repository.
- **Breaking:** the plugin's settings are now plugin options, set in `/config`: `idle_shutdown_seconds` (0 turns idle shutdown off), `document_sync` and `diagnostics_bridge`. Claude Code passes them to the launcher and they override the shell, so `TYPESCRIPT_NATIVE_LSP_DOCUMENT_SYNC=0` and `TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS=0` set in the shell no longer have an effect; turn the features off with the options instead. `TYPESCRIPT_NATIVE_LSP_TSDK` and `TYPESCRIPT_NATIVE_LSP_DEBUG` stay environment variables.
- **Breaking:** requires Claude Code 2.1.288 or newer, the first version that passes plugin options with their defaults to language servers. Older versions do not start the server.

## 1.1.3

- Fixes stale answers and ghost files returning on Claude Code 2.1.288 and newer. Those versions advertise file watching without ever sending file-change events, and document sync took the advertisement as a sign the client now handled changes and switched itself off. It now stays on regardless of what the client advertises; when disk and server agree it sends nothing.
- The diagnostics bridge likewise switches off only when the client actually requests diagnostics itself, not when it merely advertises pull support, so a client that claims support without using it keeps receiving diagnostics.
- Tests replay the initialize payload of Claude Code 2.1.292; CI covers Node 26 and uses current GitHub Actions.

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
