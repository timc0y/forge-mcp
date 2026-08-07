import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forgeTools, type ForgeToolHandlers } from '@forge/mcp-core';
import {
  outputSchemaDrift,
  registerForgeToolsV1,
  type ToolCallTelemetry
} from '../../packages/mcp-adapter-v1/src/index';

async function connect(handlers?: Partial<ForgeToolHandlers>) {
  const stubs = Object.fromEntries(
    forgeTools.map((definition) => [definition.name, async () => ({ state: 'completed', summary: 'done', next_action: 'none' })])
  ) as ForgeToolHandlers;
  const calls: ToolCallTelemetry[] = [];
  const server = new McpServer({ name: 'forge', version: 'test' });
  registerForgeToolsV1(server, { ...stubs, ...handlers }, (event) => calls.push(event));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ordinary-chat', version: '1' });
  await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls };
}

describe('direct-chat tools/list wire payload', () => {
  it('sends the eleven-tool catalog without output schemas inside a small per-turn budget', async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    await client.close();

    expect(listed.tools).toHaveLength(11);
    for (const entry of listed.tools) expect(entry, entry.name).not.toHaveProperty('outputSchema');
    expect(JSON.stringify({ tools: listed.tools }).length).toBeLessThanOrEqual(15_000);
  });

  it('keeps output-shape drift as telemetry, while delivering the successful result', async () => {
    const { client, calls } = await connect({
      forge_edit: async () => ({
        state: 'completed',
        summary: 'The commit is on GitHub.',
        next_action: 'none',
        commit_url: 'https://github.com/o/r/commit/abc'
      })
    });

    const result = await client.callTool({
      name: 'forge_edit',
      arguments: { repository: 'o/r', intent: 'Clarify design direction', files: [{ path: 'DESIGN.md', content: '# Direction' }] }
    });
    await client.close();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ commit_url: 'https://github.com/o/r/commit/abc' });
    expect(calls.at(-1)?.schemaDrift).toBeUndefined();
  });

  it('treats snake_case next actions as the compact text response', async () => {
    const { client } = await connect({
      forge_status: async () => ({ state: 'running', summary: 'Deployment is still running.', next_action: { kind: 'human', message: 'Open the status URL.' } })
    });
    const result = await client.callTool({ name: 'forge_status', arguments: { target: 'op_abc' } });
    await client.close();

    expect(result.content).toContainEqual({ type: 'text', text: 'Open the status URL.' });
  });
});

describe('direct receipt drift', () => {
  it('reports missing receipt fields without failing a tool call', () => {
    expect(outputSchemaDrift('forge_edit', { state: 'completed' })).toEqual(
      expect.arrayContaining(['summary', 'next_action'])
    );
  });
});
