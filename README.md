# typescript-native-lsp

TypeScript/JavaScript language server for Claude Code that runs TypeScript 7's native LSP (`tsc --lsp`) and falls back to typescript-language-server for TypeScript 6 and older, providing code intelligence features like go-to-definition, find references, type information, and type errors reported after edits.

## What you get

- **Type errors after edits, without running a typecheck.** When Claude edits a file, that file's errors reach the conversation on its next tool call, so mistakes are caught while Claude is still on the file rather than after a full `tsc` run. Only files Claude edits are checked, and Claude Code attaches the errors one tool call late; see Diagnostics and Limitations.
- **Compiler-backed navigation instead of grep.** Go to definition, find references, implementations, call hierarchy, document and workspace symbols, and the resolved type and documentation of any symbol.
- **TypeScript 7's speed.** The native server starts and loads large projects far faster than `tsserver`, and it is the same compiler that typechecks your build.

## Why this plugin exists

The official `typescript-lsp` plugin launches typescript-language-server, which wraps the classic `tsserver`. TypeScript 7 is the native Go port of the compiler and ships no `tsserver.js`, so on a TypeScript 7 project that plugin fails every request with:

```
Could not find a valid TypeScript installation. Please ensure that the "typescript"
dependency is installed in the workspace or that a valid `tsserver.path` is specified.
```

TypeScript 7 serves LSP itself instead, via `tsc --lsp --stdio`. This plugin launches that server when the project uses TypeScript 7 or newer, and launches typescript-language-server when it uses TypeScript 6 or older, so one plugin covers both. It is a drop-in replacement for `typescript-lsp`; the two must not be enabled together (see Installation).

## Supported Extensions
`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`

## Installation

```bash
claude plugin marketplace add rubberduck-studio/typescript-native-lsp
claude plugin install typescript-native-lsp@typescript-native-lsp
claude plugin disable typescript-lsp@claude-plugins-official
```

The last line matters. When two enabled plugins claim the same file extension, Claude Code starts only the first one it registers and never starts the other; the `/plugin` interface shows a warning naming the active one. Which plugin registers first is not something you control, so disable `typescript-lsp` rather than relying on the order. Restart Claude Code or run `/reload-plugins` afterwards.

### Requirements

- **Claude Code 2.1.50 or newer**, the first version that accepts the `startupTimeout` setting the plugin uses. Cloud sessions never start plugin language servers, so the plugin only works in local sessions.
- **Node.js** on `PATH`. The launcher is a Node script; Claude Code spawns it as `node`. Any maintained Node works for TypeScript 7 projects; the TypeScript 6 fallback runs typescript-language-server 6, which requires Node 22.22 or newer.
- **For TypeScript 7 projects:** nothing else. The project's own `typescript` dependency provides the server.
- **For TypeScript 6 projects:** typescript-language-server, either in the project (`npm install -D typescript-language-server`) or globally (`npm install -g typescript-language-server`). It uses the project's TypeScript, which must be 6 or older. Do not install a global `typescript` for this: on a fresh machine that resolves to TypeScript 7, which has no tsserver and cannot serve TypeScript 6 projects.
- **Projects without TypeScript:** a `tsc` of version 7 or newer on `PATH`, for example from `npm install -g typescript` or `brew install typescript`.

## How it works

On every start the launcher decides which server to run for the session's project directory, in this order:

1. `TYPESCRIPT_NATIVE_LSP_TSDK`, if set, as the path of a `typescript` package directory.
2. The TypeScript the project's own `tsc` runs, found by following `node_modules/.bin/tsc` to its package. This makes aliased installs work, where `node_modules/typescript` is a different package than the one behind `tsc`.
3. `node_modules/typescript`, walking up from the project directory to the nearest lockfile or git root.
4. Workspace packages under `packages/*` and `apps/*` of that root, taking the highest version.
5. `tsc` or `tsgo` on `PATH`, if `--version` reports 7 or newer.
6. typescript-language-server, project-local, then globally installed, then on `PATH`.

TypeScript 7 or newer runs as the native binary from its platform package, `tsc --lsp --stdio`. TypeScript 6 or older runs typescript-language-server with `--stdio`, always through `node` on its entry file, so it works where npm's `.cmd` shims cannot be spawned. On macOS and Linux the launcher replaces itself with the server, so Claude Code talks to the server directly.

The launcher makes no network requests and sends no telemetry. The only process it spawns besides the server is `tsc --version` when probing a binary on `PATH`. Everything it logs goes to stderr and shows up in `claude --debug` output prefixed with `[typescript-native-lsp]`.

### Troubleshooting

Run the launcher's resolve mode from the project directory to see what it would start and why. The installed copy lives in Claude Code's plugin cache; `claude plugin list --json` prints its location as `installPath`:

```bash
claude plugin list --json   # note the installPath of typescript-native-lsp
node <installPath>/scripts/launch.mjs --resolve
```

A clone of this repository works the same way: `node scripts/launch.mjs --resolve` from inside the project directory.

If a project's TypeScript is somewhere the launcher does not look, point `TYPESCRIPT_NATIVE_LSP_TSDK` at the package directory, for example `/path/to/node_modules/typescript`, in the shell that starts Claude Code.

Inside Claude Code:

- `/plugin` lists installed plugins and shows start failures in its Errors tab, including an `Executable not found in $PATH` for a missing `node`.
- `claude --debug` logs `Loaded 1 LSP server(s) from plugin: typescript-native-lsp` and `Total LSP servers loaded: N` at startup, then the launcher's `[typescript-native-lsp]` lines when the server starts, including the resolved project directory, TypeScript and command.
- `/reload-plugins` picks up plugin changes without restarting the session.

## Diagnostics

Claude Code attaches a file's type errors to the conversation after an edit, and it learns about them only through pushed `textDocument/publishDiagnostics` notifications. TypeScript 7's native server never pushes per-file diagnostics; it answers `textDocument/diagnostic` requests instead. To close that gap the launcher stays in front of the native server as a small bridge: it forwards all traffic unchanged and, after each `didOpen`, `didChange` or `didSave`, requests the file's diagnostics from the server and publishes the result to Claude Code. The effect is the same as with typescript-language-server on TypeScript 6, which pushes on its own and needs no bridge.

The bridge is an interim measure. It switches itself off when the client advertises pull-diagnostics support, and it will be removed once TypeScript pushes for such clients ([microsoft/TypeScript#63921](https://github.com/microsoft/TypeScript/pull/63921)) or Claude Code pulls ([anthropics/claude-code#40282](https://github.com/anthropics/claude-code/issues/40282)). Set `TYPESCRIPT_NATIVE_LSP_DIAGNOSTICS=0` to run the native server directly without it; `TYPESCRIPT_NATIVE_LSP_DEBUG=1` logs each request and publish to stderr.

## Git worktrees

Claude Code roots the server at the directory the session started in and keeps it there when Claude enters a git worktree later: `${CLAUDE_PROJECT_DIR}` and the server's working directory stay at the original checkout, so the launcher resolves TypeScript from that checkout. Requests on worktree files are still answered correctly, because the native server resolves each opened file's own `tsconfig.json`: a type lookup finds symbols that exist only in the worktree, and references for a worktree file return worktree paths only. This holds whether the server started before or after Claude entered the worktree. A session launched inside a worktree resolves TypeScript from the worktree itself.

The one consequence: the TypeScript that runs the server is the one installed where the session started. A worktree branch that changes the TypeScript version is served by the start directory's version. Launch the session inside the worktree or set `TYPESCRIPT_NATIVE_LSP_TSDK` if that matters.

## Limitations

- **Diagnostics arrive one tool call late.** Claude Code does not wait for a language server's diagnostics after an edit; it attaches whatever arrived by the next tool call, and drops diagnostics for a file that the very next call edits again. This is client behaviour, identical for every LSP plugin ([anthropics/claude-code#93321](https://github.com/anthropics/claude-code/issues/93321)).
- **Windows has no real-session report yet.** The launcher is written for it (no `.cmd` spawning, npm shim parsing, no `execve`) and CI completes the initialize handshake with both servers on Windows, but nobody has used it from an interactive Claude Code session on Windows so far. Reports welcome.
- **Monorepos with built package outputs.** When packages import each other through built declaration files (`dist/*.d.ts`), references from consuming packages resolve to the declaration files, not the source, so find-references on a source symbol will not list them. Any TypeScript server behaves this way. Claude Code additionally drops results in gitignored paths.
- **Linux file watching.** The native server watches files itself only on macOS and Windows. On Linux, files changed outside Claude Code (git, formatters) are not picked up until they are opened.

## Development

This plugin was built for and with the help of Claude Code and is maintained by rubberduck studio. Every change is reviewed by a human before it is merged. Behaviour was verified in real Claude Code sessions on macOS, through CI on Linux, macOS and Windows, and in git worktree sessions; see Limitations for what is known not to work.

## More Information
- [TypeScript 7 (native compiler)](https://github.com/microsoft/TypeScript/tree/main/tsc)
- [typescript-language-server on npm](https://www.npmjs.com/package/typescript-language-server)
- [Claude Code LSP plugins](https://code.claude.com/docs/en/plugins-reference)
