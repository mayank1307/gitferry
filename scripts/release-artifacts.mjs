import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'release');
await rm(output, { recursive: true, force: true });
await mkdir(output);
if (!process.env.npm_execpath) throw new Error('Run through npm run release:artifacts');
execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--pack-destination', output], { cwd: root, stdio: 'inherit' });
for (const file of ['gitferry.cjs', 'gitferry-mcp.cjs']) await copyFile(path.join(root, 'dist', file), path.join(output, file));
await copyFile(path.join(root, 'server.json'), path.join(output, 'server.json'));
const sums = [];
for (const file of (await readdir(output)).sort()) {
  const bytes = await readFile(path.join(output, file));
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${file}`);
}
await writeFile(path.join(output, 'SHA256SUMS'), `${sums.join('\n')}\n`);
console.log('Release artifacts and SHA256SUMS written to release/');
