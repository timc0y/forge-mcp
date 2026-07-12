import type { ActorRef, RepositoryRef, WorkspaceId } from '@forge/core';
export interface RepositoryAuthorization { tenantId: string; projectId: string; installationId: string; repository: RepositoryRef; permissions: readonly string[]; verifiedAt: string; }
export interface CloneCapabilityInput { actor: ActorRef; workspaceId: WorkspaceId; repository: RepositoryRef; operation: 'clone' | 'fetch' | 'push'; branchPattern?: string; expiresInSeconds: number; }
export interface GitCredentialCapability { token: string; expiresAt: string; }
export interface PullRequestInput { repository: RepositoryRef; head: string; base: string; title: string; body: string; draft: boolean; }
export interface PullRequestRef { number: number; url: string; state: string; }
export interface GitProvider { authorize(repository: RepositoryRef, actor: ActorRef): Promise<RepositoryAuthorization>; issueCredentialCapability(input: CloneCapabilityInput): Promise<GitCredentialCapability>; createPullRequest(input: PullRequestInput): Promise<PullRequestRef>; }
