# Configuration

- [Requirements in detail](#requirements-in-detail)
- [Options](#options)
- [Environment variables](#environment-variables)
- [Using tsrs](#using-tsrs)
- [Content mappers](#content-mappers)

## Requirements in detail

- **Claude Code 2.1.288 or newer**, the first version that passes a plugin's options, with their defaults, to its language servers. Older versions do not start the server. Cloud sessions never start plugin language servers, so the plugin only works in local sessions.
- **Node.js 22.18 or newer** on `PATH`. Claude Code spawns the launcher as `node`, and the plugin is written in TypeScript that Node runs directly by stripping the types, which Node does by default from 22.18 on. The fallback for TypeScript 6 and older runs typescript-language-server 6, which requires Node 22.22 or newer.
- **For TypeScript 7 projects:** nothing else. The project's own `typescript` dependency provides the server.
- **For TypeScript 6 and older:** typescript-language-server, either in the project (`npm install -D typescript-language-server`) or globally (`npm install -g typescript-language-server`). It locates TypeScript itself, as the project's `typescript` dependency, which must be 6 or older and a full install, not an API-only package. Do not install a global `typescript` for this: on a fresh machine that resolves to TypeScript 7, which has no tsserver and cannot serve TypeScript 6 projects.
- **Projects without TypeScript:** a global TypeScript 7 or newer, from `npm install -g typescript` on any platform, or on macOS and Linux any `tsc` on `PATH` such as `brew install typescript`.

How the launcher finds each of these is described in [Choosing the server](how-it-works.md#choosing-the-server).

## Options

Plugin options apply to every project. Change them in `/config`, with `/plugin configure typescript-native-lsp@typescript-native-lsp`, or at install with `claude plugin install … --config <option>=<value>`. Every option has a default, so installing prints that the options are not yet set and an interactive install shows them in a dialog; leaving them as they are is fine.

| Option | Default | What it does |
| --- | --- | --- |
| `idle_shutdown_seconds` | `600` | Stops the server after this many seconds without activity and starts it again when Claude next needs it (see [Idle shutdown](how-it-works.md#idle-shutdown)). `0` keeps it running for the whole session. |
| `document_sync` | on | Keeps the files Claude has open in line with disk (see [Document sync](how-it-works.md#document-sync)). |
| `diagnostics_bridge` | on | Reports type errors after edits on TypeScript 7 (see [Diagnostics bridge](how-it-works.md#diagnostics-bridge)). |
| `content_mappers` | on | Lets TypeScript 7.1 and tsrs run the content mappers a project's `tsconfig.json` declares (see [Content mappers](#content-mappers)). |

`document_sync` and `diagnostics_bridge` are workarounds you should only need to turn off to rule them out while troubleshooting. The switches accept true/false, 1/0, yes/no and on/off. A value the launcher does not recognise leaves a workaround on, but turns content mappers off, since they run code.

## Environment variables

A few settings are environment variables instead, because they are per project, per machine or per run. Set them in the shell that starts Claude Code or in the `env` block of a [settings file](https://code.claude.com/docs/en/settings-reference#env), such as a project's `.claude/settings.json`.

| Variable | What it does |
| --- | --- |
| `TYPESCRIPT_NATIVE_LSP_TSDK` | Path of the `typescript` package (version 7 or newer) or tsrs package to run, skipping the search. A relative path is taken from the project directory. See [Using tsrs](#using-tsrs) and [Troubleshooting](troubleshooting.md#typescript-in-an-unusual-place). |
| `TYPESCRIPT_NATIVE_LSP_GLOBAL_ROOTS` | A `PATH`-style list of directories that replaces the places the launcher looks for global packages. See [Global installs](troubleshooting.md#global-installs). |
| `TYPESCRIPT_NATIVE_LSP_DEBUG` | `1` logs what the proxy does to stderr, including each diagnostics request and publish. |
| `TSRS_BINARY` | tsrs's own variable for a local build, honoured as tsrs's launcher does. |

## Using tsrs

[tsrs](https://github.com/oxc-project/tsrs) is a Rust port of TypeScript 7 whose language server speaks the same protocol as TypeScript 7's and serves diagnostics the same way, so everything here works with it. It is never picked up on its own, because a project may install it for type-checking in CI rather than in the editor. To run it for a project, install it there (`npm install -D tsrs`) and point `TYPESCRIPT_NATIVE_LSP_TSDK` at it in the project's `.claude/settings.json`:

```json
{
  "env": {
    "TYPESCRIPT_NATIVE_LSP_TSDK": "node_modules/tsrs"
  }
}
```

The setting also accepts the directories tsrs's own editor setup names, `node_modules/tsrs/tsdk` and on Windows its platform package such as `node_modules/@tsrs/win32-x64`. `TSRS_BINARY`, tsrs's variable for a local build, is honoured as tsrs's launcher does.

## Content mappers

TypeScript 7.1 lets a project's `tsconfig.json` declare `contentMappers`: packages that turn other file types, such as CSS modules, into TypeScript, so the server can type them and navigate into them. A mapper runs whatever command its `package.json` names, and the package can be a dependency or a directory in the repository, so the server runs mappers only when the client allows it. Without that, files a mapper would handle fall back to whatever ambient declarations match them, such as a bundler's `*.module.css` index signature.

The plugin allows it, as TypeScript's own VS Code extension does in every workspace you trust. That puts mappers on the same footing as a project's hooks and settings, which Claude Code also runs: after you trust the folder, without asking in a folder under one you already trust, and without asking at all in `claude -p` and SDK runs. Unlike hooks, mappers still run when hooks are turned off or project settings are not loaded, because the plugin cannot see those settings. Set the `content_mappers` option to off if you work in repositories you do not trust, or with Claude Code configured not to run their hooks.

The launcher passes the permission as `runExternalCode` in the server's `initialize`, which is the only way to pass it: `tsc --lsp` has no command-line flag for it. It takes effect with TypeScript 7.1 and newer and with tsrs builds of TypeScript 7.1; earlier versions ignore it, and TypeScript 6 and older have no content mappers. Current TypeScript 7.1 builds load a mapper only from inside the session's directory, the one Claude Code started in, so in a monorepo a session started in a package directory does not run mappers installed at the repository root; start it at the root. Content mappers are new in TypeScript 7.1 and may still change before it is released.
