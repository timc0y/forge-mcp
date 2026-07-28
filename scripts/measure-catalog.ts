/**
 * Measure the real `tools/list` wire payload.
 *
 * NOT the generated schema file: that drops `outputSchema`, `annotations` and
 * `_meta`, so optimising against it optimises a proxy. This drives a real
 * McpServer through an in-memory transport and weighs the bytes a host
 * actually receives on every turn.
 *
 *   pnpm tsx scripts/measure-catalog.ts [--json]
 */
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forgeTools, type ForgeToolHandlers } from '@forge/mcp-core';
import { registerForgeToolsV1 } from '@forge/mcp-adapter-v1';

const handlers = Object.fromEntries(
  forgeTools.map((tool) => [tool.name, async () => ({})])
) as unknown as ForgeToolHandlers;

const server = new McpServer({ name: 'forge', version: 'measure' });
registerForgeToolsV1(server, handlers);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'measure', version: '1' });
await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);

const listed = await client.listTools();
await client.close();

const bytes = (value: unknown): number => (value === undefined ? 0 : JSON.stringify(value).length);
const totalWire = bytes({ tools: listed.tools });

type Row = {
  name: string;
  total: number;
  input: number;
  output: number;
  prose: number;
  annotations: number;
  meta: number;
};

const rows: Row[] = listed.tools.map((tool) => {
  const record = tool as unknown as Record<string, unknown>;
  return {
    name: tool.name,
    total: bytes(tool),
    input: bytes(record.inputSchema),
    output: bytes(record.outputSchema),
    prose: bytes(record.description) + bytes(record.title),
    annotations: bytes(record.annotations),
    meta: bytes(record._meta)
  };
});

const sum = (key: keyof Omit<Row, 'name'>): number => rows.reduce((acc, row) => acc + row[key], 0);
const tok = (n: number): string => `~${Math.round(n / 4)} tok`;

const dump = process.argv.find((arg) => arg.startsWith('--tool='))?.slice('--tool='.length);
if (dump) {
  const tool = listed.tools.find((candidate) => candidate.name === dump);
  console.log(tool ? JSON.stringify(tool, null, 1) : `no such tool: ${dump}`);
} else if (process.argv.includes('--wire')) {
  console.log(JSON.stringify({ tools: listed.tools }, null, 1));
} else if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ totalWire, rows }, null, 2));
} else {
  console.log(`tools/list wire payload: ${totalWire} bytes  ${tok(totalWire)}  (${rows.length} tools)`);
  const withOutput = rows.filter((row) => row.output > 0).length;
  for (const [label, key, note] of [
    ['inputSchema ', 'input', ''],
    ['outputSchema', 'output', ` (${withOutput}/${rows.length} tools carry one)`],
    ['desc+title  ', 'prose', ''],
    ['annotations ', 'annotations', ''],
    ['_meta       ', 'meta', '']
  ] as const) {
    const value = sum(key);
    console.log(
      `  ${label} ${String(value).padStart(6)}b  ${tok(value).padStart(10)}  ${String(
        Math.round((value / totalWire) * 100)
      ).padStart(2)}%${note}`
    );
  }

  console.log('\nheaviest tools:');
  for (const row of [...rows].sort((a, b) => b.total - a.total).slice(0, 10)) {
    console.log(
      `  ${String(row.total).padStart(5)}b ${tok(row.total).padStart(9)}  ${row.name.padEnd(28)}` +
        ` in=${row.input} out=${row.output} prose=${row.prose}`
    );
  }
}
