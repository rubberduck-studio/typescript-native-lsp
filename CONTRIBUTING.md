# Contributing

## Prerequisites

- Node.js 22.22 or newer (typescript-language-server 6, used by the TypeScript 6 fixture, needs it)
- Claude Code 2.1.50 or newer, for `claude plugin validate` and for trying the plugin in a session

## Develop and test

```bash
npm run fixtures                                          # installs TypeScript 7, TypeScript 6 and an aliased setup under test/fixtures
npm test                                                  # resolver units, initialize handshakes, diagnostics and exit paths against both servers, bridge edge cases against a fake server
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
- `scripts/diagnostics-bridge.mjs` turns the native server's pull diagnostics into pushes. It is an appendix: when TypeScript or Claude Code closes the gap, delete the file, the `useBridge` branch in `launch.mjs`, `test/diagnostics-bridge.test.mjs`, `test/helpers/fake-native-server.mjs` and the Diagnostics section of the README. `test/diagnostics.test.mjs` is written against the behaviour, not the bridge, and must keep passing afterwards.
- `test/helpers/lsp-session.mjs` drives the launcher as Claude Code does. Sessions run with the plugin's own `TYPESCRIPT_NATIVE_LSP_*` variables cleared and global roots emptied, so a developer's shell or global installs cannot steer a test.
- `.lsp.json` is the server configuration Claude Code reads.
- `test/fixtures/claude-code-client.json` is what Claude Code sends in `initialize`, so session tests behave like the real client. To refresh it after a Claude Code release, point a throwaway plugin's `.lsp.json` at a script that appends every incoming message to a file and answers `initialize` with empty capabilities, run `claude -p` with `--plugin-dir` on any TypeScript file, and copy the captured `clientInfo`, `initializationOptions` and `capabilities`.
- The README's "How it works" section is the specification for the resolution order. Change both together.

## Pull requests

Using AI tools to prepare a change is fine, and expected for a plugin like this. Say so in the pull request description, and be able to explain every part of the change yourself. Keep the README's Limitations section honest: if a change fixes or introduces a known limit, update it.
