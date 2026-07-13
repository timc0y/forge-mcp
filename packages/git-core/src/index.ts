import type { ActorRef, RepositoryRef, WorkspaceId } from '@forge/core';
export interface RepositoryAuthorization { tenantId: string; projectId: string; installationId: string; repository: RepositoryRef; permissions: readonly string[]; verifiedAt: string; }
export interface CloneCapabilityInput { actor: ActorRef; workspaceId: WorkspaceId; repository: RepositoryRef; operation: 'clone' | 'fetch' | 'push'; branchPattern?: string; expiresInSeconds: number; }
export interface GitCredentialCapability { token: string; expiresAt: string; }
export interface PullRequestInput { repository: RepositoryRef; head: string; base: string; title: string; body: string; draft: boolean; }
export interface PullRequestRef { number: number; url: string; state: string; }
export interface GitProvider { authorize(repository: RepositoryRef, actor: ActorRef): Promise<RepositoryAuthorization>; issueCredentialCapability(input: CloneCapabilityInput): Promise<GitCredentialCapability>; createPullRequest(input: PullRequestInput): Promise<PullRequestRef>; }

export interface ReceivePackCommand {
  oldCommit: string;
  newCommit: string;
  ref: string;
}

export function parseReceivePackCommands(bytes: Uint8Array): ReceivePackCommand[] | null {
  const decoder = new TextDecoder();
  const commands: ReceivePackCommand[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const header = decoder.decode(bytes.subarray(offset, offset + 4));
    if (!/^[a-f0-9]{4}$/i.test(header)) throw new Error('Git receive-pack request has an invalid packet header.');
    const length = Number.parseInt(header, 16);
    if (length === 0) return commands;
    if (length < 4) throw new Error('Git receive-pack request has an invalid packet length.');
    if (offset + length > bytes.length) return null;
    const line = decoder.decode(bytes.subarray(offset + 4, offset + length)).split('\0', 1)[0]?.trim() ?? '';
    const [oldCommit, newCommit, ref] = line.split(/\s+/u);
    if (!oldCommit || !newCommit || !ref || !/^[a-f0-9]{40,64}$/i.test(oldCommit) || !/^[a-f0-9]{40,64}$/i.test(newCommit)) {
      throw new Error('Git receive-pack request contains an invalid update command.');
    }
    commands.push({ oldCommit, newCommit, ref });
    offset += length;
  }
  return null;
}

export function assertReceivePackScope(commands: ReceivePackCommand[] | null, branch: string, commit: string): void {
  if (!commands?.length || commands.some((command) => command.ref !== `refs/heads/${branch}` || command.newCommit !== commit)) {
    throw new Error('Git receive-pack request is outside the approved branch or commit scope.');
  }
}
