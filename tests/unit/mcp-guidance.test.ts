import { describe, expect, it } from 'vitest';
import {
  FORGE_MCP_INSTRUCTIONS,
  dashboardFirstPrompts
} from '../../apps/forge-edge-gateway/src/mcp-guidance';

describe('direct-chat MCP guidance', () => {
  it('states durable user-level invariants without teaching control-plane choreography', () => {
    expect(FORGE_MCP_INSTRUCTIONS.length).toBeLessThan(1_200);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/read before edit/i);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/GitHub/i);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/small|bounded/i);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/phone and desktop/i);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/secret values/i);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/do not retry/i);
    expect(FORGE_MCP_INSTRUCTIONS).not.toMatch(/forge_(?:task|workspace|process|deps|observer)_/i);
    expect(FORGE_MCP_INSTRUCTIONS).not.toMatch(/→|poll/i);
  });

  it('gives the dashboard ordinary-chat examples for the supported outcomes', () => {
    const prompts = dashboardFirstPrompts('timc0y');
    expect(prompts).toHaveLength(4);
    const copy = prompts.join('\n');
    expect(copy).toMatch(/design direction/i);
    expect(copy).toMatch(/small code change/i);
    expect(copy).toMatch(/deploy/i);
    expect(copy).toMatch(/phone and desktop/i);
  });
});
