import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const temp = await mkdtemp(path.join(os.tmpdir(), 'gitferry-package-'));
const standalone = await mkdtemp(path.join(os.tmpdir(), 'gitferry-offline-'));
// Use npm's JS entry point directly for cross-platform argument handling (no shell).
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this check through npm run smoke:package');
const npm = (args, cwd = root) => execFileSync(process.execPath, [npmCli, ...args], {
  cwd, encoding: 'utf8', timeout: 180_000,
  env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  maxBuffer: 8 * 1024 * 1024,
});

async function checkMcp(entry, args = [], cwd = temp) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, ...args], cwd, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (data) => { stderr += String(data); });
  const client = new Client({ name: 'gitferry-package-check', version: pkg.version });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, pkg.version);
    const result = await client.listTools();
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['apply_bundle', 'inspect_bundle', 'pack_changes']);
  } catch (error) {
    throw new Error(`Packaged MCP failed: ${entry} ${args.join(' ')}\n${stderr}`, { cause: error });
  } finally {
    await client.close();
  }
}

try {
  const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', temp, '--silent']));
  assert.equal(packed.length, 1);
  const files = new Set(packed[0].files.map((file) => file.path));
  for (const file of ['dist/cli.js', 'dist/mcp.js', 'dist/mcp/server.js', 'dist/mcp/server.d.ts', 'dist/gitferry.cjs', 'dist/gitferry-mcp.cjs', 'LICENSE', 'INSTALL.md', 'SCENARIOS.md', 'SECURITY.md', 'server.json', 'docs/DEPLOYMENT.md', 'examples/mcp/local.json']) {
    assert(files.has(file), `Missing packaged file: ${file}`);
  }
  assert(![...files].some((file) => /^(src|test|node_modules)\//.test(file)), 'Unexpected development files in tarball');
  await writeFile(path.join(temp, 'package.json'), JSON.stringify({ name: 'gitferry-isolated-check', private: true }));
  npm(['install', '--ignore-scripts', '--no-package-lock', '--omit=dev', path.join(temp, packed[0].filename)], temp);
  const installed = path.join(temp, 'node_modules', ...pkg.name.split('/'));
  // Resolve the public exports as an installed consumer. The factory import
  // must not start stdio or emit anything merely by being imported.
  const importOutput = execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { pack, apply, inspect, VERSION } from 'gitferry';
    import { createGitFerryServer } from 'gitferry/mcp';
    assert.equal(VERSION, ${JSON.stringify(pkg.version)});
    for (const operation of [pack, apply, inspect]) assert.equal(typeof operation, 'function');
    await createGitFerryServer().close();
  `], { cwd: temp, encoding: 'utf8', timeout: 10_000 });
  assert.equal(importOutput, '', 'Library imports must keep stdout silent');
  for (const file of ['dist/cli.js', 'dist/gitferry.cjs']) {
    const version = execFileSync(process.execPath, [path.join(installed, file), '--version'], { cwd: temp, encoding: 'utf8', timeout: 10_000 }).trim();
    assert.equal(version, pkg.version);
  }
  await checkMcp(path.join(installed, 'dist/mcp.js'));
  await checkMcp(path.join(installed, 'dist/cli.js'), ['mcp']);
  // Run copied single files away from the installed package and node_modules.
  // This catches accidental external dependencies in supposedly offline bundles.
  for (const file of ['gitferry.cjs', 'gitferry-mcp.cjs']) {
    await copyFile(path.join(installed, 'dist', file), path.join(standalone, file));
  }
  assert.equal(execFileSync(process.execPath, [path.join(standalone, 'gitferry.cjs'), '--version'], { cwd: standalone, encoding: 'utf8', timeout: 10_000 }).trim(), pkg.version);
  await checkMcp(path.join(standalone, 'gitferry-mcp.cjs'), [], standalone);
  await checkMcp(path.join(standalone, 'gitferry.cjs'), ['mcp'], standalone);
  console.log(`Isolated package installation and all MCP entry points passed: ${pkg.name}@${pkg.version}`);
} finally {
  await rm(temp, { recursive: true, force: true });
  await rm(standalone, { recursive: true, force: true });
}
