import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { featureFlags } from '@forge/core';
import { forgeTools } from '@forge/mcp-core';
import { z } from 'zod';

const root = resolve(import.meta.dirname, '..');
const schemaDir = resolve(root, 'schemas');
const check = process.argv.includes('--check');

const tools = Object.fromEntries(
  forgeTools.map((tool) => [
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      sideEffect: tool.sideEffect,
      approval: tool.approval,
      inputSchema: z.toJSONSchema(z.object(tool.inputSchema), {
        target: 'draft-2020-12',
        reused: 'ref'
      })
    }
  ])
);

const documents = new Map<string, string>([
  [
    resolve(schemaDir, 'forge-tools.schema.json'),
    `${JSON.stringify(
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'Forge MCP tool schemas',
        version: 1,
        generatedAt: 'deterministic',
        tools
      },
      null,
      2
    )}\n`
  ],
  [
    resolve(root, 'feature-flags.json'),
    `${JSON.stringify({ schemaVersion: 1, flags: featureFlags }, null, 2)}\n`
  ]
]);

await mkdir(schemaDir, { recursive: true });
let changed = false;
for (const [path, content] of documents) {
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch {
    // File will be created below.
  }
  if (current === content) continue;
  changed = true;
  if (!check) await writeFile(path, content);
  else console.error(`Generated file is stale: ${path.replace(`${root}/`, '')}`);
}

if (check && changed) process.exitCode = 1;
