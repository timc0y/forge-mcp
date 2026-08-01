import { access, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// Domain packages that must stay free of Cloudflare / MCP / UI SDKs.
// Keep this list equal to packages that still exist under packages/*/src —
// a deleted package left here fails the check with a clear message.
const domainPackages = [
  'application',
  'artifacts-core',
  'browser-core',
  'core',
  'events',
  'insight',
  'policy',
  'project-detection',
  'sandbox-core',
  'task-core'
];
const forbidden = [
  '@cloudflare/',
  'cloudflare:',
  '@modelcontextprotocol/',
  "from 'agents",
  'octokit',
  "from 'react",
  "from 'hono"
];

async function files(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) output.push(...(await files(child)));
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) output.push(child);
  }
  return output;
}

const violations: string[] = [];
for (const name of domainPackages) {
  const source = resolve(root, 'packages', name, 'src');
  try {
    await access(source);
  } catch {
    violations.push(`packages/${name}/src: listed in check-boundaries but missing on disk`);
    continue;
  }
  for (const file of await files(source)) {
    const content = await readFile(file, 'utf8');
    for (const token of forbidden) {
      if (content.includes(token)) {
        violations.push(`${file.replace(`${root}/`, '')}: forbidden dependency token ${token}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Dependency boundaries valid across ${domainPackages.length} domain packages.`);
}
