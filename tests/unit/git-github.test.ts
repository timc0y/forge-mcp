import { describe, expect, it } from 'vitest';
import { generateKeyPair, exportPKCS8, decodeJwt } from 'jose';
import { GitHubAppGitProvider, type InstallationResolver } from '@forge/git-github';
import { verifyCapability } from '@forge/capabilities';
import type { ActorRef, RepositoryRef } from '@forge/core';

describe('git-github package', () => {
  const dummySigningKey = 'k_test_capability_signing_key_32bytes_long!';

  const mockResolver: InstallationResolver = {
    async resolve(repository: RepositoryRef, actor: ActorRef) {
      return {
        installationId: 'inst_12345',
        tenantId: 'ten_test123',
        projectId: 'prj_test123',
        permissions: ['contents:read', 'contents:write']
      };
    }
  };

  it('generates a valid RS256 JWT for GitHub App authentication', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPkcs8 = await exportPKCS8(privateKey);

    const provider = new GitHubAppGitProvider(
      {
        appId: '123456',
        privateKeyPkcs8,
        capabilitySigningKey: dummySigningKey
      },
      mockResolver
    );

    const jwt = await provider.createAppJwt();
    expect(jwt).toBeDefined();

    const decoded = decodeJwt(jwt);
    expect(decoded.iss).toBe('123456');
    expect(decoded.exp).toBeGreaterThan(decoded.iat!);
  });

  it('authorizes a repository and returns Installation details', async () => {
    const provider = new GitHubAppGitProvider(
      {
        appId: '123456',
        privateKeyPkcs8: '',
        capabilitySigningKey: dummySigningKey
      },
      mockResolver
    );

    const repo: RepositoryRef = { provider: 'github', owner: 'forge-owner', name: 'forge-repo' };
    const actor: ActorRef = { type: 'user', id: 'usr_1' };

    const auth = await provider.authorize(repo, actor);
    expect(auth.installationId).toBe('inst_12345');
    expect(auth.tenantId).toBe('ten_test123');
    expect(auth.projectId).toBe('prj_test123');
    expect(auth.repository).toEqual(repo);
    expect(auth.verifiedAt).toBeDefined();
  });

  it('issues a verifiable git credential capability token', async () => {
    const provider = new GitHubAppGitProvider(
      {
        appId: '123456',
        privateKeyPkcs8: '',
        capabilitySigningKey: dummySigningKey
      },
      mockResolver
    );

    const repo: RepositoryRef = { provider: 'github', owner: 'forge-owner', name: 'forge-repo' };
    const actor: ActorRef = { type: 'user', id: 'usr_1' };

    const cap = await provider.issueCredentialCapability({
      repository: repo,
      actor,
      workspaceId: 'ws_01234567890123456789012' as any,
      operation: 'fetch',
      expiresInSeconds: 120
    });

    expect(cap.token).toBeDefined();
    expect(cap.expiresAt).toBeDefined();

    const verified = await verifyCapability(cap.token, dummySigningKey, {
      workspaceId: 'ws_01234567890123456789012',
      action: 'git:fetch'
    });
    expect(verified).not.toBeNull();
    expect(verified?.tenantId).toBe('ten_test123');
    expect(verified?.action).toBe('git:fetch');
  });

  it('throws expected error on createPullRequest when unhandled', async () => {
    const provider = new GitHubAppGitProvider(
      {
        appId: '123456',
        privateKeyPkcs8: '',
        capabilitySigningKey: dummySigningKey
      },
      mockResolver
    );

    const repo: RepositoryRef = { provider: 'github', owner: 'forge-owner', name: 'forge-repo' };
    await expect(
      provider.createPullRequest({
        repository: repo,
        head: 'forge/feat',
        base: 'main',
        title: 'Title',
        body: 'Body'
      })
    ).rejects.toThrow('PR creation is not enabled');
  });
});
