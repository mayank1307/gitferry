// Preserve published assets on retries: identical files are skipped, differences fail.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

assert(process.env.GITHUB_ACTIONS === 'true', 'Automated publishing is restricted to GitHub Actions');
const tag = process.env.RELEASE_TAG;
assert(tag?.startsWith('v'), 'RELEASE_TAG is required');
const root = path.resolve(import.meta.dirname, '..');
const gh = (args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8', timeout: 120_000 });
const exists = spawnSync('gh', ['release', 'view', tag], { cwd: root, stdio: 'ignore' });
if (exists.status !== 0) gh(['release', 'create', tag, '--verify-tag', '--title', `GitFerry ${tag}`, '--notes-file', 'CHANGELOG.md']);
const release = JSON.parse(gh(['release', 'view', tag, '--json', 'assets']));
const names = new Set(release.assets.map((asset) => asset.name));
const temp = await mkdtemp(path.join(os.tmpdir(), 'gitferry-release-assets-'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
try {
  for (const file of (await readdir(path.join(root, 'release'))).sort()) {
    const local = path.join(root, 'release', file);
    if (names.has(file)) {
      gh(['release', 'download', tag, '--pattern', file, '--dir', temp]);
      assert.equal(sha256(await readFile(path.join(temp, file))), sha256(await readFile(local)), `Existing GitHub release asset differs: ${file}`);
    } else {
      gh(['release', 'upload', tag, local]);
    }
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
console.log(`Verified GitHub release assets for ${tag}`);
