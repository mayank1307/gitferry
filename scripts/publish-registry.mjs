// Registry publication is deliberately separate so npm success is retryable.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

assert(process.env.GITHUB_ACTIONS === 'true', 'Automated publishing is restricted to GitHub Actions');
const server = JSON.parse(await readFile(new URL('../server.json', import.meta.url), 'utf8'));
const url = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}`;
const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
if (response.ok) {
  const published = (await response.json()).server;
  // Compare publisher-controlled metadata. Registry-added status/meta may differ.
  for (const field of ['name', 'version', 'description', 'title', 'repository', 'packages']) {
    assert.deepEqual(published?.[field], server[field], `Existing registry ${field} differs; refuse to reuse its version`);
  }
  console.log(`Verified existing MCP Registry entry: ${server.name}@${server.version}`);
} else {
  assert.equal(response.status, 404, `MCP Registry lookup failed: ${response.status}`);
  const binary = process.env.MCP_PUBLISHER;
  assert(binary, 'Set MCP_PUBLISHER to the verified publisher binary');
  execFileSync(binary, ['login', 'github-oidc'], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(binary, ['publish'], { stdio: 'inherit', timeout: 120_000 });
}
