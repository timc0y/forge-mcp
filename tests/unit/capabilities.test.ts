import { describe, expect, it } from 'vitest';
import { issueCapability, verifyCapability, type CapabilityClaims } from '@forge/capabilities';

const secret = 'this-is-a-development-test-secret-with-32-bytes';
function claims(expiresAt = Math.floor(Date.now() / 1000) + 60): CapabilityClaims {
  return {
    version: 1,
    subject: 'user_1',
    tenantId: 'ten_1',
    workspaceId: 'ws_0123456789abcdefghjkmnpq',
    action: 'preview.read',
    nonce: 'nonce_1',
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt
  };
}

describe('Forge capabilities', () => {
  it('round-trips scoped claims', async () => {
    const token = await issueCapability(claims(), secret);
    const verified = await verifyCapability(token, secret, {
      workspaceId: claims().workspaceId,
      action: 'preview.read'
    });
    expect(verified.subject).toBe('user_1');
  });

  it('rejects tampering, wrong scope and expiry', async () => {
    const token = await issueCapability(claims(), secret);
    const [payload, signature] = token.split('.');
    const tampered = `${payload?.startsWith('a') ? 'b' : 'a'}${payload?.slice(1)}.${signature}`;
    await expect(
      verifyCapability(tampered, secret, {
        workspaceId: claims().workspaceId,
        action: 'preview.read'
      })
    ).rejects.toMatchObject({ code: 'FORGE_PERMISSION_DENIED' });
    await expect(
      verifyCapability(token, secret, {
        workspaceId: claims().workspaceId,
        action: 'workspace.destroy'
      })
    ).rejects.toMatchObject({ code: 'FORGE_PERMISSION_DENIED' });
    const expired = await issueCapability(claims(Math.floor(Date.now() / 1000) - 1), secret);
    await expect(
      verifyCapability(expired, secret, {
        workspaceId: claims().workspaceId,
        action: 'preview.read'
      })
    ).rejects.toMatchObject({ code: 'FORGE_PERMISSION_DENIED' });
  });

  it('enforces optional repository, branch and commit scope', async () => {
    const scoped = await issueCapability({
      ...claims(),
      action: 'git:push',
      repository: 'example/project',
      branchPattern: 'forge/tim/fix',
      gitCommit: 'a'.repeat(40)
    }, secret);
    await expect(verifyCapability(scoped, secret, {
      workspaceId: claims().workspaceId,
      action: 'git:push',
      repository: 'example/project',
      branchPattern: 'forge/tim/other'
    })).rejects.toMatchObject({ code: 'FORGE_PERMISSION_DENIED' });
  });
});
