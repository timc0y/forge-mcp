import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../apps/forge-edge-gateway/src/index.ts', import.meta.url),
  'utf8'
);
const sessionSource = readFileSync(
  new URL('../../apps/forge-edge-gateway/src/mcp-session.ts', import.meta.url),
  'utf8'
);

describe('direct-chat MCP endpoint', () => {
  it('serves one MCP resource at /mcp', () => {
    expect(source).toContain("url.pathname === '/mcp'");
    expect(source).not.toContain("url.pathname === '/mcp/chat'");
    expect(source).not.toContain("'/mcp/chat'");
    expect(source).not.toMatch(/catalog\s*[:=]/u);
  });

  it('registers one direct-chat catalog and no workflow prompts', () => {
    expect(sessionSource).toContain('registerForgeToolsV1(');
    expect(sessionSource).not.toContain('registerForgeChatToolsV1');
    expect(sessionSource).not.toContain('registerPrompt(');
    expect(sessionSource).not.toMatch(/catalog\??:/u);
  });

  it('serves signed operation status pages outside the MCP turn', () => {
    expect(source).toContain('chatOperationStatusPage');
    expect(source).toContain('const statusMatch');
  });
});
