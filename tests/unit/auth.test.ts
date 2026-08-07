import { describe, expect, it } from 'vitest';
import { constantTimeEqual, oauthChallenge } from '../../apps/forge-edge-gateway/src/auth';

describe('constantTimeEqual', () => {
  it('accepts only byte-identical values', () => {
    expect(constantTimeEqual('internal-preview-key', 'internal-preview-key')).toBe(true);
    expect(constantTimeEqual('internal-preview-key', 'internal-preview-kez')).toBe(false);
    expect(constantTimeEqual('short', 'longer')).toBe(false);
  });
});

describe('oauthChallenge', () => {
  const env = { FORGE_PUBLIC_ORIGIN: 'https://forge.example' } as never;

  it('advertises the sole direct-chat MCP resource', () => {
    expect(oauthChallenge(env)).toBe(
      'Bearer resource_metadata="https://forge.example/.well-known/oauth-protected-resource/mcp", scope="forge:workspace"'
    );
    expect(oauthChallenge(env)).not.toContain('/mcp/chat');
  });
});
