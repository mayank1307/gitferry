import { rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

// Always rebuild from source: a stale standalone bundle must never enter npm.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (process.argv.includes('--bundle')) {
  await Promise.all([
    build({ entryPoints: ['src/cli.ts'], outfile: 'dist/gitferry.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs' }),
    build({ entryPoints: ['src/mcp.ts'], outfile: 'dist/gitferry-mcp.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs' }),
  ]);
}
