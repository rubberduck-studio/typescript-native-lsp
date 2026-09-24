# typescript-native-lsp

TypeScript/JavaScript language server for Claude Code that runs TypeScript 7's native LSP (`tsc --lsp`) and falls back to typescript-language-server for TypeScript 6 and older, providing code intelligence features like go-to-definition, find references and hover.

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

The last line matters. Claude Code hands each file extension to the first plugin that claims it and never starts the other, so with both enabled one of them silently does nothing. Restart Claude Code or run `/reload-plugins` afterwards.

### Requirements

- **Node.js** on `PATH`. The launcher is a Node script; Claude Code spawns it as `node`.
- **For TypeScript 7 projects:** nothing else. The project's own `typescript` dependency provides the server.
- **For TypeScript 6 projects:** typescript-language-server, either in the project (`npm install -D typescript-language-server`) or globally (`npm install -g typescript-language-server`). It uses the project's TypeScript, which must be 6 or older; a global `typescript` install is not needed.
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

Run the launcher's resolve mode from the project directory to see what it would start and why:

```bash
node ~/.claude/plugins/marketplaces/typescript-native-lsp/scripts/launch.mjs --resolve
```

If a project's TypeScript is somewhere the launcher does not look, point `TYPESCRIPT_NATIVE_LSP_TSDK` at the package directory, for example `/path/to/node_modules/typescript`, in the shell that starts Claude Code.

## Limitations

- **No diagnostics on TypeScript 7.** The native server only reports errors when asked (pull diagnostics), and Claude Code currently only listens for pushed ones. So the automatic "errors after edit" feedback does not work on TypeScript 7 projects until either side changes. Navigation, hover and symbols are unaffected. The TypeScript 6 fallback keeps pushed diagnostics. Upstream: [microsoft/TypeScript#63921](https://github.com/microsoft/TypeScript/pull/63921), [anthropics/claude-code#40282](https://github.com/anthropics/claude-code/issues/40282).
- **Windows has no real-session report yet.** The launcher is written for it (no `.cmd` spawning, npm shim parsing, no `execve`) and CI completes the initialize handshake with both servers on Windows, but nobody has used it from an interactive Claude Code session on Windows so far. Reports welcome.
- **Monorepos with built package outputs.** When packages import each other through built declaration files (`dist/*.d.ts`), references from consuming packages resolve to the declaration files, not the source, so find-references on a source symbol will not list them. Any TypeScript server behaves this way. Claude Code additionally drops results in gitignored paths.
- **Linux file watching.** The native server watches files itself only on macOS and Windows. On Linux, files changed outside Claude Code (git, formatters) are not picked up until they are opened.

## More Information
- [TypeScript 7 (native compiler)](https://github.com/microsoft/TypeScript/tree/main/tsc)
- [typescript-language-server on npm](https://www.npmjs.com/package/typescript-language-server)
- [Claude Code LSP plugins](https://code.claude.com/docs/en/plugins-reference)
