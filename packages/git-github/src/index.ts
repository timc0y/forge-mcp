import { SignJWT, importPKCS8 } from 'jose';
import { issueCapability } from '@forge/capabilities';
import type { ActorRef, RepositoryRef } from '@forge/core';
import type {
  CloneCapabilityInput,
  GitCredentialCapability,
  GitProvider,
  PullRequestInput,
  PullRequestRef,
  RepositoryAuthorization
} from '@forge/git-core';

export interface GitHubAppConfig {
  appId: string;
  privateKeyPkcs8: string;
  capabilitySigningKey: string;
  apiBaseUrl?: string;
}

export interface InstallationResolver {
  resolve(
    repository: RepositoryRef,
    actor: ActorRef
  ): Promise<{
    installationId: string;
    tenantId: string;
    projectId: string;
    permissions: string[];
  }>;
}

function actorSubject(actor: ActorRef): string {
  switch (actor.type) {
    case 'user':
    case 'agent':
    case 'service':
      return `${actor.type}:${actor.id}`;
    case 'github_app':
      return `github_app:${actor.installationId}`;
  }
}

export class GitHubAppGitProvider implements GitProvider {
  constructor(
    private readonly config: GitHubAppConfig,
    private readonly installations: InstallationResolver
  ) {}

  async authorize(
    repository: RepositoryRef,
    actor: ActorRef
  ): Promise<RepositoryAuthorization> {
    const value = await this.installations.resolve(repository, actor);
    return {
      ...value,
      repository,
      verifiedAt: new Date().toISOString()
    };
  }

  async issueCredentialCapability(
    input: CloneCapabilityInput
  ): Promise<GitCredentialCapability> {
    const authorization = await this.authorize(input.repository, input.actor);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + Math.min(300, input.expiresInSeconds);
    const token = await issueCapability(
      {
        version: 1,
        subject: actorSubject(input.actor),
        tenantId: authorization.tenantId,
        workspaceId: input.workspaceId,
        repository: `${input.repository.owner}/${input.repository.name}`,
        action: `git:${input.operation}`,
        branchPattern: input.branchPattern,
        nonce: crypto.randomUUID(),
        issuedAt: now,
        expiresAt
      },
      this.config.capabilitySigningKey
    );
    return {
      token,
      expiresAt: new Date(expiresAt * 1000).toISOString()
    };
  }

  async createPullRequest(input: PullRequestInput): Promise<PullRequestRef> {
    throw new Error(
      `PR creation is not enabled in the Phase 1 vertical slice for ${input.repository.owner}/${input.repository.name}.`
    );
  }

  async createAppJwt(): Promise<string> {
    const key = await importPKCS8(this.config.privateKeyPkcs8, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(this.config.appId)
      .setIssuedAt(now - 30)
      .setExpirationTime(now + 540)
      .sign(key);
  }
}
