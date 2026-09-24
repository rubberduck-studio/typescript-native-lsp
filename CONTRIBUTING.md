# Contributing

## Prerequisites

- Node.js 22 or newer
- Claude Code 2.1.50 or newer, for `claude plugin validate` and for trying the plugin in a session

## Develop and test

```bash
npm run fixtures                                          # installs TypeScript 7, TypeScript 6 and an aliased setup under test/fixtures
npm test                                                  # resolver unit tests plus real initialize handshakes against both servers
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin validate --strict .claude-plugin/marketplace.json
```

To try a change against a real project, start Claude Code in that project with the checkout loaded as a plugin, and disable the official TypeScript plugin for that session:

```bash
claude --plugin-dir /path/to/typescript-native-lsp --settings '{"enabledPlugins":{"typescript-lsp@claude-plugins-official":false}}'
```

`claude --debug` shows the launcher's `[typescript-native-lsp]` lines when the server starts. `node scripts/launch.mjs --resolve` from inside a project prints what the launcher would start and why.

CI runs the same tests on Linux, macOS and Windows with Node 22 and 24, and validates both manifests.

## Where things live

- `scripts/resolve.mjs` decides which server to run; `scripts/launch.mjs` starts it.
- `.lsp.json` is the server configuration Claude Code reads.
- The README's "How it works" section is the specification for the resolution order. Change both together.

## Pull requests

Using AI tools to prepare a change is fine, and expected for a plugin like this. Say so in the pull request description, and be able to explain every part of the change yourself. Keep the README's Limitations section honest: if a change fixes or introduces a known limit, update it.
