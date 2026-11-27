# How it works

The plugin is a launcher that Claude Code starts as the language server. It picks the right server for the project, starts it, and stays in front of it as a small proxy. This page describes each part. For setup see the [README](../README.md); for settings see [Configuration](configuration.md).

- [Choosing the server](#choosing-the-server)
- [Running the server](#running-the-server)
- [Diagnostics bridge](#diagnostics-bridge)
- [Document sync](#document-sync)
- [Idle shutdown](#idle-shutdown)
- [Git worktrees](#git-worktrees)
- [Network and processes](#network-and-processes)

## Choosing the server

On every start the launcher decides which server to run for the session's project directory, in this order:

1. `TYPESCRIPT_NATIVE_LSP_TSDK`, if set, as the path of a `typescript` package directory of version 7 or newer, or of tsrs (see [Using tsrs](configuration.md#using-tsrs)). A relative path is taken from the project directory.
2. Every typescript package installed under `node_modules`, walking up from the project directory to the nearest lockfile or git root. A package counts by the name in its own package.json, not by its directory, so an alias such as `"@typescript/native": "npm:typescript@7"` is found wherever the package manager hoisted it. The highest version wins, so an aliased TypeScript 7 next to a TypeScript 6 API shim is picked up. This works the same under npm, pnpm, yarn and bun.
3. Workspace packages under `packages/*` and `apps/*` of that root, same rule.
4. A `typescript` package of version 7 or newer under the global npm root (`TYPESCRIPT_NATIVE_LSP_GLOBAL_ROOTS` overrides where to look, see [Global installs](troubleshooting.md#global-installs)).
5. On macOS and Linux, `tsc` or `tsgo` on `PATH`, if `--version` reports 7 or newer.
6. For TypeScript 6 and older: typescript-language-server, project-local, then under the global npm root, then on macOS and Linux on `PATH`. It locates TypeScript on its own, as the first `node_modules/typescript` above the workspace, so the launcher only checks that this will succeed and fails early with an explanation when it will not.

## Running the server

TypeScript 7 or newer runs as the native binary from its platform package, `tsc --lsp --stdio`, and tsrs as its binary, `tsrs --lsp --stdio`. TypeScript 6 or older runs typescript-language-server with `--stdio` through `node` on its entry file, with its separate syntax server turned off (`useSyntaxServer: "never"`): that server answers definitions, references and hovers from the open files alone while the project loads, which an agent cannot tell from a complete answer, so requests wait for the project instead. Either way the launcher stays in front of the server as a small proxy that stops it when idle and works around gaps in Claude Code's LSP client, described below. With idle shutdown and every option the proxy handles switched off, the launcher replaces itself with the server on macOS and Linux. Nothing is ever run through a shell, and `.cmd` shims are never executed, which is why global installs are resolved as packages rather than found on `PATH` on Windows.

## Diagnostics bridge

Claude Code attaches a file's type errors to the conversation after an edit, and it learns about them only through pushed `textDocument/publishDiagnostics` notifications. TypeScript 7's native server never pushes per-file diagnostics; it answers `textDocument/diagnostic` requests instead. To close that gap the proxy bridges the two for the native server: it forwards all traffic unchanged and, after each `didOpen`, `didChange` or `didSave`, requests the file's diagnostics from the server and publishes the result to Claude Code. The effect is the same as with typescript-language-server on TypeScript 6 and older, which pushes on its own and needs no bridge.

The bridge is an interim measure. It switches itself off once the client requests diagnostics itself, rather than when it merely advertises support, and it will be removed once TypeScript pushes for such clients ([microsoft/TypeScript#63921](https://github.com/microsoft/TypeScript/pull/63921)) or Claude Code pulls ([anthropics/claude-code#40282](https://github.com/anthropics/claude-code/issues/40282)). The `diagnostics_bridge` option turns it off; `TYPESCRIPT_NATIVE_LSP_DEBUG=1` logs each request and publish to stderr.

## Document sync

Claude Code tells the language server only about files its own Edit and Write tools touch, and it never closes a document. Servers treat an open document as authoritative over disk, so once Claude has touched a file, changes made to it by shell commands, git, formatters or codegen stay invisible for the rest of the session, and a renamed or deleted file lingers in the program. Answers then point into files that no longer exist, and diagnostics report conflicts with them. This affects every LSP plugin, including the official one ([anthropics/claude-code#76870](https://github.com/anthropics/claude-code/issues/76870)).

Claude Code has no unsaved buffers, so disk is always the truth. Before every request the proxy compares each document Claude has opened with its file: a changed file is sent to the server with its current content, a deleted file is closed and its diagnostics cleared, and a file that reappears is opened again. Checking costs a file-status call per open document, well under a millisecond per request. It works the same for TypeScript 7 and TypeScript 6 and older.

This is an interim measure, and it will be removed once Claude Code itself sends the new content of open files that change on disk, or closes them ([anthropics/claude-code#76870](https://github.com/anthropics/claude-code/issues/76870)). It stays on regardless of what the client advertises: since 2.1.288 Claude Code advertises file watching but never sends file-change events, and such events would not refresh open documents anyway, because servers treat an open document as the client's. When disk and server agree it sends nothing. The `document_sync` option turns it off.

## Idle shutdown

Claude Code keeps a language server running from its first request until the session ends, and TypeScript's servers keep the memory of every project they have loaded until they exit. On a large repository that is about 2 GB after opening a single file and can grow past 6 GB once many files have been checked, per session, including sessions that have long since moved on to other work.

So the proxy stops the server once Claude Code has sent nothing for 10 minutes and no request is waiting for an answer, and starts a new one when Claude next needs it: on the next request, or on the next edit, so that the edit's type errors are still reported. The new server gets the session's original settings and every file the old one had open, with the same content, so answers continue where they left off. The cost is a cold start on that first request: about a second for a hover on a repository of 4,700 TypeScript files, well inside Claude Code's 60-second request limit. An edit that wakes the server waits for that cold start too, so its type errors are more likely to reach the conversation a tool call later than usual (see [Limitations](../README.md#limitations)). Activity means what Claude Code sends and the server's answers to it. The server's own log and progress messages do not count, or a server watching a busy repository would never be stopped.

The idle period is the `idle_shutdown_seconds` option (see [Options](configuration.md#options)). Each restart looks for the server again, so a TypeScript upgrade or branch switch while the server was stopped is picked up; when the project switched between TypeScript 7 and 6, the launcher ends and Claude Code starts it again with the right setup. If the server cannot be started, for example while `node_modules` is being reinstalled or when it does not answer within a minute, the request fails in a way Claude Code retries, and the next request tries again.

## Git worktrees

Claude Code roots the server at the directory the session started in and keeps it there when Claude enters a git worktree later: `${CLAUDE_PROJECT_DIR}` and the server's working directory stay at the original checkout, so the launcher resolves TypeScript from that checkout. Requests on worktree files are still answered correctly, because the native server resolves each opened file's own `tsconfig.json`: a type lookup finds symbols that exist only in the worktree, and references for a worktree file return worktree paths only. This holds whether the server started before or after Claude entered the worktree. A session launched inside a worktree resolves TypeScript from the worktree itself.

Two consequences. The TypeScript that runs the server is the one installed where the session started, so a worktree branch that changes the TypeScript version is served by the start directory's version; launch the session inside the worktree or set `TYPESCRIPT_NATIVE_LSP_TSDK` if that matters. And a session launched inside a worktree needs that worktree to have its own `node_modules`: resolution stops at the worktree's `.git` file and does not fall through to the main checkout, on purpose, since the main checkout may hold different dependency versions.

## Network and processes

The launcher makes no network requests and sends no telemetry. The only processes it spawns besides the server are `tsc --version` and `tsgo --version`, on macOS and Linux only, when probing a binary on `PATH`. Everything it logs goes to stderr and shows up in `claude --debug` output prefixed with `[typescript-native-lsp]`.
