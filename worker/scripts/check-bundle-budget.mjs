import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '/tmp/forge-worker');
const PLATFORM_LIMIT = 64 * 1024 * 1024;
const FORGE_BUDGET = 48 * 1024 * 1024;

function bytes(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += bytes(target);
    else if (entry.isFile()) total += fs.statSync(target).size;
  }
  return total;
}

if (!fs.existsSync(root)) throw new Error(`Worker dry-run output does not exist: ${root}`);
const total = bytes(root);
const mib = (total / 1024 / 1024).toFixed(2);
console.log(`Forge Worker dry-run bundle: ${mib} MiB; internal budget 48 MiB; Cloudflare limit 64 MiB.`);
if (total >= PLATFORM_LIMIT) throw new Error('Worker bundle reaches or exceeds Cloudflare’s 64 MiB uncompressed limit.');
if (total > FORGE_BUDGET) throw new Error('Worker bundle exceeds Forge’s 48 MiB internal budget; preserve at least 25% platform-size headroom.');
