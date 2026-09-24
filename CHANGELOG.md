# Changelog

## 0.1.0

Initial release.

- Runs TypeScript 7's native language server (`tsc --lsp --stdio`) for projects on TypeScript 7 or newer.
- Falls back to typescript-language-server for projects on TypeScript 6 or older.
- Resolves the TypeScript the project's own `tsc` runs, so aliased installs work.
- Falls back to `tsc` or `tsgo` on PATH when the project has no TypeScript.
- `TYPESCRIPT_NATIVE_LSP_TSDK` overrides resolution with an explicit TypeScript package directory.
- `node scripts/launch.mjs --resolve` prints the resolved command for troubleshooting.
