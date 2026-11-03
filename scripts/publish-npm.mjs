// Used only by the release workflow. This script publishes when not passed --verify-only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tarball = path.join(root, 'release', `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`);
const candidate = await readFile(tarball);
const integrity = `sha512-${createHash('sha512').update(candidate).digest('base64')}`;
const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`;
const getMetadata = async () => {
  const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null;
  assert(response.ok, `npm metadata request failed: ${response.status}`);
  return response.json();
};
let remote = await getMetadata();
if (!remote && !process.argv.includes('--verify-only')) {
  assert(process.env.GITHUB_ACTIONS === 'true', 'Automated publishing is restricted to GitHub Actions');
  execFileSync(process.execPath, [process.env.npm_execpath, 'publish', tarball, '--access', 'public'], { cwd: root, stdio: 'inherit' });
  // npm's public read endpoint may lag a successful publish briefly.
  for (const delay of [0, 2_000, 4_000, 6_000, 8_000]) {
    if (delay) await setTimeout(delay);
    remote = await getMetadata();
    if (remote) break;
  }
}
assert(remote, `${pkg.name}@${pkg.version} is not published`);
assert.equal(remote.mcpName, pkg.mcpName, 'Published npm package has a different registry identity');
assert.equal(remote.dist.integrity, integrity, 'Published tarball differs from this release; refuse to reuse its version');
const downloadUrl = new URL(remote.dist.tarball);
assert.equal(downloadUrl.origin, 'https://registry.npmjs.org', 'Unexpected npm tarball origin');
const download = await fetch(downloadUrl, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
assert(download.ok && download.body, `npm tarball download failed: ${download.status}`);
const reader = download.body.getReader();
const hash = createHash('sha512');
let downloadedBytes = 0;
try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    downloadedBytes += value.byteLength;
    assert(downloadedBytes <= candidate.byteLength, 'Downloaded npm tarball exceeds candidate size');
    hash.update(value);
  }
} finally {
  await reader.cancel();
  reader.releaseLock();
}
assert.equal(downloadedBytes, candidate.byteLength, 'Downloaded npm tarball is truncated');
assert.equal(`sha512-${hash.digest('base64')}`, integrity, 'Downloaded npm tarball differs from release candidate');
console.log(`Verified public npm artifact: ${pkg.name}@${pkg.version}`);
