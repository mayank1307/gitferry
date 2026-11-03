import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const json = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
const pkg = await json('package.json');
const lock = await json('package-lock.json');
const server = await json('server.json');
const source = await readFile(new URL('../src/version.ts', import.meta.url), 'utf8');
const sourceVersion = source.match(/export const VERSION = "([^"]+)"/)?.[1];
const schema = await json('scripts/schemas/server-2025-12-11.schema.json');
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
assert(ajv.validate(schema, server), `server.json schema: ${ajv.errorsText()}`);
for (const [name, version] of Object.entries({ lock: lock.version, lockRoot: lock.packages[''].version, source: sourceVersion, registry: server.version, package: server.packages[0].version })) {
  assert.equal(version, pkg.version, `${name} version must match package.json`);
}
assert.equal(lock.name, pkg.name);
assert.equal(lock.packages[''].name, pkg.name);
assert.equal(server.name, pkg.mcpName);
assert.equal(server.packages.length, 1);
const distribution = server.packages[0];
assert.equal(distribution.registryType, 'npm');
assert.equal(distribution.identifier, pkg.name);
assert.equal(distribution.transport.type, 'stdio');
assert.equal(distribution.runtimeHint, 'npx');
assert.deepEqual(distribution.packageArguments, [{ type: 'positional', value: 'mcp' }]);
assert.equal(pkg.bin['gitferry-mcp'], 'dist/mcp.js');
assert.equal(pkg.bin.gitferry, 'dist/cli.js');
assert.equal(pkg.license, 'MIT');
assert.equal(pkg.publishConfig.access, 'public');
assert.equal(pkg.repository.url, `${server.repository.url}.git`);
const tag = process.env.RELEASE_TAG ?? (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);
if (tag) assert.equal(tag, `v${pkg.version}`, 'release tag must match package version');
for (const file of ['LICENSE', 'README.md', 'INSTALL.md', 'SCENARIOS.md', 'SECURITY.md', 'CHANGELOG.md', 'PUBLISHING.md', 'DEMO.md']) {
  assert((await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).trim(), `${file} must exist`);
}
console.log(`Release metadata valid: ${pkg.name}@${pkg.version} (${server.name})`);
