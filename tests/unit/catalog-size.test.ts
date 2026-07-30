import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forgeTools, type ForgeToolHandlers } from '@forge/mcp-core';
import {
  outputSchemaDrift,
  slimResponse,
  registerForgeToolsV1,
  type ToolCallTelemetry
} from '../../packages/mcp-adapter-v1/src/index';

/**
 * Drive a real McpServer over an in-memory transport, so these assertions are
 * about the bytes a host actually receives — not about the generated schema
 * file, which omits outputSchema, annotations and _meta and therefore cannot
 * measure the catalog's real cost.
 */
async function connect(handlers?: Partial<ForgeToolHandlers>) {
  const stubs = Object.fromEntries(
    forgeTools.map((definition) => [definition.name, async () => ({})])
  ) as unknown as ForgeToolHandlers;
  const calls: ToolCallTelemetry[] = [];
  const server = new McpServer({ name: 'forge', version: 'test' });
  registerForgeToolsV1(server, { ...stubs, ...handlers } as ForgeToolHandlers, (event) => {
    calls.push(event);
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls };
}

describe('tools/list wire payload', () => {
  it('sends no outputSchema, and stays inside its per-turn byte budget', async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    await client.close();

    // Registering the declared output shapes cost 25,454 bytes — 37% of a
    // 68,099-byte catalog, re-read every turn — to describe payloads the agent
    // receives in full when it calls the tool. They are enforced off-wire
    // instead (see outputSchemaDrift).
    for (const entry of listed.tools) {
      expect(entry, entry.name).not.toHaveProperty('outputSchema');
    }

    const bytes = JSON.stringify({ tools: listed.tools }).length;
    // Measured 42,293 at 42 tools. The headroom is for a tool that earns its
    // rent, not for schemas growing unwatched; `pnpm catalog:measure` shows
    // where any increase went.
    expect(bytes).toBeLessThanOrEqual(46_000);
  });
});

describe('output shape enforcement', () => {
  it('names the fields that drifted from a declared shape', () => {
    expect(outputSchemaDrift('forge_edit', { branch: 'forge/x' })).toEqual(
      expect.arrayContaining(['mutationOutcome', 'durability', 'on_remote'])
    );
    expect(outputSchemaDrift('forge_edit', {
      mutationOutcome: 'committed_remote',
      durability: 'remote_branch',
      on_remote: true,
      durability_statement: 'on GitHub',
      branch: 'forge/x',
      paths: ['a.ts'],
      rebased: false,
      next_step: 'run the tests'
    })).toBeUndefined();
  });

  it('still delivers a correct result whose shape drifted', async () => {
    // The failure this replaces: the SDK turns any mismatch against a
    // registered outputSchema into a hard -32602, so a commit that really
    // reached GitHub reads to the agent as a broken tool — and it retries an
    // edit that already landed. Report the drift; never destroy the result.
    const { client, calls } = await connect({
      forge_edit: (async () => ({
        commit_url: 'https://github.com/o/r/commit/abc',
        next_step: 'the work is on GitHub'
      })) as never
    });

    const result = await client.callTool({
      name: 'forge_edit',
      arguments: { files: [{ path: 'a.ts', content: 'x' }] }
    });
    await client.close();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      commit_url: 'https://github.com/o/r/commit/abc'
    });
    expect(calls.at(-1)?.schemaDrift).toEqual(expect.arrayContaining(['durability']));
  });
});

describe('response slimming', () => {
  const operation = {
    operationId: 'op_abc',
    originalOperationId: 'op_abc',
    replayed: false,
    idempotencyKey: 'a-key-the-agent-sent',
    compact: true,
    exitCode: 0
  };

  it('drops fields that restate a sibling in the same response', () => {
    expect(slimResponse('forge_shell', operation)).toEqual({
      operationId: 'op_abc',
      replayed: false,
      exitCode: 0
    });
  });

  it('keeps the original operation id when the call really was a replay', () => {
    const replay = { ...operation, replayed: true, originalOperationId: 'op_first' };
    expect(slimResponse('forge_shell', replay).originalOperationId).toBe('op_first');
  });

  it('answers forge_operation_get in full, since that bookkeeping is its subject', () => {
    expect(slimResponse('forge_operation_get', operation)).toEqual(operation);
  });
});
