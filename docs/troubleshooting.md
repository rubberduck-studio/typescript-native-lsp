# Troubleshooting

- [See what the launcher would start](#see-what-the-launcher-would-start)
- [Check inside Claude Code](#check-inside-claude-code)
- [The server never starts](#the-server-never-starts)
- [TypeScript in an unusual place](#typescript-in-an-unusual-place)
- [Global installs](#global-installs)

## See what the launcher would start

Run the launcher's resolve mode from the project directory to see what it would start and why. The installed copy lives in Claude Code's plugin cache; `claude plugin list --json` prints its location as `installPath`:

```bash
claude plugin list --json   # note the installPath of typescript-native-lsp
node <installPath>/scripts/launch.mjs --resolve
```

A clone of this repository works the same way: `node scripts/launch.mjs --resolve` from inside the project directory. Run from a shell, it shows the options as your shell's environment sets them, normally their defaults; the values set in Claude Code only reach the launcher when Claude Code starts it.

## Check inside Claude Code

- `/plugin` lists installed plugins and shows start failures in its Errors tab, including an `Executable not found in $PATH` for a missing `node`.
- `claude --debug` logs `Loaded 1 LSP server(s) from plugin: typescript-native-lsp` and `Total LSP servers loaded: N` at startup, then the launcher's `[typescript-native-lsp]` lines when the server starts, including the resolved project directory, TypeScript and command.
- `/reload-plugins` picks up plugin changes without restarting the session.

Setting `TYPESCRIPT_NATIVE_LSP_DEBUG=1` adds a log line for everything the proxy does.

## The server never starts

- **The official plugin is still enabled.** When two enabled plugins claim the same file extension, Claude Code starts only the first one it registers and never starts the other; the `/plugin` interface shows a warning naming the active one. Which plugin registers first is not something you control, so disable `typescript-lsp` (`claude plugin disable typescript-lsp@claude-plugins-official`) rather than relying on the order, then restart Claude Code or run `/reload-plugins`.
- **Claude Code is older than 2.1.288**, or the session is a cloud session. See [Requirements in detail](configuration.md#requirements-in-detail).
- **Node is missing or too old.** `/plugin` shows `Executable not found in $PATH` for a missing `node`; on a Node older than 22.18, or with type stripping disabled, the launcher says so on stderr.
- **A TypeScript 6 project without typescript-language-server.** The launcher exits with a message naming what it looked for; install it in the project or globally.

## TypeScript in an unusual place

If a project's TypeScript 7 is somewhere the launcher does not look, point `TYPESCRIPT_NATIVE_LSP_TSDK` at the package directory, for example `/path/to/node_modules/typescript`, in the shell that starts Claude Code. The override applies to TypeScript 7 or newer; typescript-language-server finds TypeScript 6 and older on its own.

## Global installs

Global installs are found in the usual places for the global npm root, including the one of the `node` that runs the launcher, which covers `npm install -g` with any Node version manager that keeps global packages with each Node version, such as nvm or mise. Tools that give every global package a directory of its own are not covered: Volta (`volta install`) and mise's npm backend (`mise use -g npm:typescript-language-server`). On macOS and Linux typescript-language-server's shim on `PATH` still works; on Windows, where the launcher never runs shims, list the package's parent directory in `TYPESCRIPT_NATIVE_LSP_GLOBAL_ROOTS`, a `PATH`-style list (`;`-separated on Windows) that replaces the places the launcher looks for global packages:

| Installed with | Directory to list |
| --- | --- |
| Volta | `tools\shared` under `VOLTA_HOME`, by default `%LOCALAPPDATA%\Volta\tools\shared` (all Volta packages) |
| mise, npm backend | `node_modules` in the directory `mise where npm:typescript-language-server` prints, such as `%LOCALAPPDATA%\mise\installs\npm-typescript-language-server\6.1.0\node_modules`; it names the version, so update it after an upgrade |

Settings files do not expand variables such as `%LOCALAPPDATA%`, so write the full path, and add the global npm root (`%APPDATA%\npm\node_modules`) to the list if you also install with `npm install -g`. `--resolve` shows whether the package is found.
