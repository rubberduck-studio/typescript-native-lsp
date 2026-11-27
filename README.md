# typescript-native-lsp

[![ci](https://github.com/rubberduck-studio/typescript-native-lsp/actions/workflows/ci.yml/badge.svg)](https://github.com/rubberduck-studio/typescript-native-lsp/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/rubberduck-studio/typescript-native-lsp)](https://github.com/rubberduck-studio/typescript-native-lsp/releases)
[![license](https://img.shields.io/github/license/rubberduck-studio/typescript-native-lsp)](LICENSE)

TypeScript/JavaScript language server for Claude Code that runs TypeScript 7's native LSP (`tsc --lsp`) and falls back to typescript-language-server for TypeScript 6 and older, providing code intelligence features like go-to-definition, find references, type information, and type errors reported after edits.

## Why use it

The official [`typescript-lsp`](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/typescript-lsp) plugin launches typescript-language-server, which wraps the classic `tsserver`. TypeScript 7 is the native Go port of the compiler and ships no `tsserver.js`, so on a TypeScript 7 project that plugin fails every request with:

```
Could not find a valid TypeScript installation. Please ensure that the "typescript"
dependency is installed in the workspace or that a valid `tsserver.path` is specified.
```

This plugin is a drop-in replacement that covers TypeScript 7 and older versions alike, and closes several gaps between Claude Code and its language servers:

- **Type errors after edits, without running a typecheck.** When Claude edits a file, that file's errors reach the conversation on its next tool call, so mistakes are caught while Claude is still on the file rather than after a full `tsc` run. → [Diagnostics](#diagnostics)
- **Answers that match the files on disk.** Files changed by shell commands, git, formatters or codegen are picked up before the next request, and renamed or deleted files leave the program instead of lingering as ghosts. → [Files changed outside Claude Code](#files-changed-outside-claude-code)
- **Compiler-backed navigation instead of grep.** Go to definition, find references, implementations, call hierarchy, document and workspace symbols, and the resolved type and documentation of any symbol.
- **Memory back when Claude is busy elsewhere.** A server that has received nothing for 10 minutes is stopped and starts again, with the same open files, when Claude next needs it. On a large repository that returns several GB per session. → [Idle shutdown](#idle-shutdown)
- **TypeScript 7's speed.** The native server starts and loads large projects far faster than `tsserver`, and it is the same compiler that typechecks your build.

| | `typescript-lsp` (official) | This plugin |
| --- | --- | --- |
| TypeScript 7 projects | Every request fails | Native server, `tsc --lsp` |
| TypeScript 6 and older | typescript-language-server | typescript-language-server |
| Type errors after edits | TypeScript 6 and older | All versions |
| Files changed outside Claude Code | Stale until the session ends | Picked up before the next request |
| Memory of an idle session | Held until the session ends | Released after 10 minutes |
| [tsrs](#using-tsrs), [content mappers](#content-mappers) | No | Yes |

## Supported Extensions
`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`

## Installation

```bash
claude plugin marketplace add rubberduck-studio/typescript-native-lsp
claude plugin install typescript-native-lsp@typescript-native-lsp
claude plugin disable typescript-lsp@claude-plugins-official
```

The last line matters: the two plugins must not be enabled together, because Claude Code starts only one server per file extension and you do not control which. Restart Claude Code or run `/reload-plugins` afterwards.

**Check that it works:** start `claude --debug` in a TypeScript project and look for `Loaded 1 LSP server(s) from plugin: typescript-native-lsp`. Start failures show up in the Errors tab of `/plugin`.

**Update:**

```bash
claude plugin marketplace update typescript-native-lsp
claude plugin update typescript-native-lsp@typescript-native-lsp
```

### Requirements

| | Needs |
| --- | --- |
| Always | Claude Code 2.1.288 or newer, in a local session (cloud sessions never start plugin language servers). Node.js 22.18 or newer on `PATH`. |
| TypeScript 7 project | Nothing else. The project's own `typescript` dependency provides the server. |
| TypeScript 6 or older project | typescript-language-server, in the project (`npm install -D typescript-language-server`) or global (`npm install -g typescript-language-server`), and Node.js 22.22 or newer. Do not install a global `typescript` for this. |
| Project without TypeScript | A global TypeScript 7 or newer (`npm install -g typescript`), or on macOS and Linux any `tsc` on `PATH`, such as `brew install typescript`. |

The reasons behind each are in [Requirements in detail](docs/configuration.md#requirements-in-detail).

## Configuration

### Options

Plugin options apply to every project. Change them in `/config`, with `/plugin configure typescript-native-lsp@typescript-native-lsp`, or at install with `--config <option>=<value>`. The defaults are fine to leave as they are.

| Option | Default | What it does |
| --- | --- | --- |
| `idle_shutdown_seconds` | `600` | Stops the server after this many seconds without activity and starts it again when Claude next needs it. `0` keeps it running for the whole session. |
| `document_sync` | on | Keeps the files Claude has open in line with disk. |
| `diagnostics_bridge` | on | Reports type errors after edits on TypeScript 7. |
| `content_mappers` | on | Lets TypeScript 7.1 and tsrs run the content mappers a project's `tsconfig.json` declares. |

`document_sync` and `diagnostics_bridge` are workarounds you should only need to turn off to rule them out while troubleshooting.

### Environment variables

Settings that are per project, per machine or per run. Set them in the shell that starts Claude Code or in the `env` block of a [settings file](https://code.claude.com/docs/en/settings-reference#env).

| Variable | What it does |
| --- | --- |
| `TYPESCRIPT_NATIVE_LSP_TSDK` | Path of the TypeScript 7 or tsrs package to run, skipping the search. |
| `TYPESCRIPT_NATIVE_LSP_GLOBAL_ROOTS` | Where to look for global packages, as a `PATH`-style list. |
| `TYPESCRIPT_NATIVE_LSP_DEBUG` | `1` logs what the proxy does to stderr. |

Details: [docs/configuration.md](docs/configuration.md).

## How it works

On every start the launcher picks a server for the session's project directory: the project's own TypeScript 7 or newer runs as its native binary (`tsc --lsp --stdio`), and a project on TypeScript 6 or older gets typescript-language-server. It looks in the project's `node_modules` (including aliased packages and workspace packages), then in global installs, then on `PATH`. The launcher then stays in front of the server as a small proxy that provides the features below. It makes no network requests, sends no telemetry and never runs anything through a shell.

The full resolution order and the details of each feature are in [docs/how-it-works.md](docs/how-it-works.md).

### Diagnostics

Claude Code only listens for type errors a server pushes, and TypeScript 7's native server only answers when asked. After each edit the proxy asks the server for the file's errors and publishes them to Claude Code. The bridge is an interim measure that switches itself off once Claude Code asks itself ([anthropics/claude-code#40282](https://github.com/anthropics/claude-code/issues/40282)) and will be removed once either side closes the gap ([microsoft/TypeScript#63921](https://github.com/microsoft/TypeScript/pull/63921)). → [Details](docs/how-it-works.md#diagnostics-bridge)

### Files changed outside Claude Code

Claude Code tells the server only about files its own Edit and Write tools touch, and never closes one, so changes made by shell commands, git, formatters or codegen stay invisible for the rest of the session. This affects every LSP plugin ([anthropics/claude-code#76870](https://github.com/anthropics/claude-code/issues/76870)). Before every request the proxy compares each open document with its file and sends the server what changed. → [Details](docs/how-it-works.md#document-sync)

### Idle shutdown

Claude Code keeps a language server running until the session ends, and TypeScript's servers hold about 2 GB after opening a single file of a large repository, growing past 6 GB. The proxy stops the server after 10 minutes without activity and starts a new one, with the same open files, on the next request or edit. That first request is a cold start: about a second on a repository of 4,700 TypeScript files. → [Details](docs/how-it-works.md#idle-shutdown)

### Content mappers

TypeScript 7.1 lets a `tsconfig.json` declare `contentMappers`, packages that turn other file types such as CSS modules into TypeScript. A mapper runs a command the project names, so the server runs them only when the client allows it. The plugin allows it, as TypeScript's own VS Code extension does in trusted workspaces. Turn the `content_mappers` option off if you work in repositories you do not trust. → [Details, including what "trusted" means here](docs/configuration.md#content-mappers)

### Using tsrs

[tsrs](https://github.com/oxc-project/tsrs), the Rust port of TypeScript 7, works with everything here. It is never picked up on its own; set `TYPESCRIPT_NATIVE_LSP_TSDK` to `node_modules/tsrs` in the project's `.claude/settings.json`. → [Details](docs/configuration.md#using-tsrs)

### Git worktrees

When Claude enters a worktree mid-session, the server stays rooted where the session started, and requests on worktree files are still answered correctly. A session launched inside a worktree needs that worktree to have its own `node_modules`. → [Details](docs/how-it-works.md#git-worktrees)

## Troubleshooting

Run the launcher's resolve mode from the project directory to see what it would start and why:

```bash
claude plugin list --json   # note the installPath of typescript-native-lsp
node <installPath>/scripts/launch.mjs --resolve
```

Inside Claude Code, `/plugin` shows start failures in its Errors tab, and `claude --debug` shows the launcher's log lines, prefixed with `[typescript-native-lsp]`.

[docs/troubleshooting.md](docs/troubleshooting.md) covers a server that never starts, TypeScript in a place the launcher does not look, and global installs with Volta or mise on Windows.

## Limitations

- **The first request after an idle period is a cold start.** See [Idle shutdown](#idle-shutdown).
- **Diagnostics arrive one tool call late, and only for files Claude edits.** Claude Code does not wait for a language server's diagnostics after an edit; it attaches whatever arrived by the next tool call, and drops diagnostics for a file that the very next call edits again. It also opens a file with the server only when it edits it, so an edit that breaks a different file goes unnoticed until a full typecheck. Both are client behaviour, identical for every LSP plugin ([anthropics/claude-code#93321](https://github.com/anthropics/claude-code/issues/93321)).
- **Windows is covered by CI, with little real-session experience.** The launcher is written for it (no `.cmd` spawning, npm shim parsing, no `execve`) and CI runs the test suite against both servers on Windows. Reports from interactive Claude Code sessions on Windows are welcome.
- **Monorepos with built package outputs.** When packages import each other through built declaration files (`dist/*.d.ts`), references from consuming packages resolve to the declaration files, not the source, so find-references on a source symbol will not list them. Any TypeScript server behaves this way. Claude Code additionally drops results in gitignored paths.
- **Linux file watching for files Claude has not opened.** Files Claude has opened are kept in sync with disk on every platform. Other files are the server's own business: the native server watches them only on macOS and Windows, so on Linux a file TypeScript 7 loaded as a dependency and that later changed outside Claude Code is not picked up until Claude opens it. tsrs does not watch them on Windows either yet.

## Development

This plugin was built for and with the help of Claude Code and is maintained by rubberduck studio. Every change is reviewed by a human before it is merged. Behaviour was verified in real Claude Code sessions on macOS, through CI on Linux, macOS and Windows, and in git worktree sessions; see Limitations for what is known not to work.

See [CONTRIBUTING.md](CONTRIBUTING.md) to work on it and [CHANGELOG.md](CHANGELOG.md) for what changed.

## More Information
- [TypeScript 7 (native compiler)](https://github.com/microsoft/TypeScript/tree/main/tsc)
- [typescript-language-server on npm](https://www.npmjs.com/package/typescript-language-server)
- [Claude Code LSP plugins](https://code.claude.com/docs/en/plugins-reference)

## License

[MIT](LICENSE)
