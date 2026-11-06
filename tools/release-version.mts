/**
 * npm's `version` hook: copies the version npm has just written to package.json
 * into the plugin manifest and turns the changelog's "Unreleased" section into
 * that version's, so `npm version <major|minor|patch>` makes the whole release
 * commit and tag. Fails, changing nothing, when the changelog has no entries
 * under "Unreleased".
 */
import fs from 'node:fs';

const MANIFEST = '.claude-plugin/plugin.json';
const CHANGELOG = 'CHANGELOG.md';
const UNRELEASED = '## Unreleased\n\n- ';
const VERSION_FIELD = /"version": "[^"]*"/;

const version = process.env.npm_package_version;
if (undefined === version) {
	throw new Error('run this through `npm version`, which sets npm_package_version');
}

const manifest = fs.readFileSync(MANIFEST, 'utf8');
const changelog = fs.readFileSync(CHANGELOG, 'utf8');
if (false === VERSION_FIELD.test(manifest)) {
	throw new Error(`${MANIFEST} has no version field`);
}
if (false === changelog.includes(UNRELEASED)) {
	throw new Error(`${CHANGELOG} has no entries under "## Unreleased" to release`);
}
fs.writeFileSync(MANIFEST, manifest.replace(VERSION_FIELD, `"version": "${version}"`));
fs.writeFileSync(CHANGELOG, changelog.replace(UNRELEASED, `## ${version}\n\n- `));
