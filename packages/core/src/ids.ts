const PREFIXES = {
  tenant: 'ten', project: 'prj', workspace: 'ws', operation: 'op', approval: 'apr', artifact: 'art', preview: 'prv', process: 'proc', credentialProfile: 'crp', task: 'task', deferred: 'dfr', secret: 'sec', siteReview: 'srv'
} as const;

export type Branded<T, Brand extends string> = T & { readonly __brand: Brand };
export type TenantId = Branded<string, 'TenantId'>;
export type ProjectId = Branded<string, 'ProjectId'>;
export type WorkspaceId = Branded<string, 'WorkspaceId'>;
export type OperationId = Branded<string, 'OperationId'>;
export type ApprovalId = Branded<string, 'ApprovalId'>;
export type ArtifactId = Branded<string, 'ArtifactId'>;
export type PreviewId = Branded<string, 'PreviewId'>;
export type ProcessId = Branded<string, 'ProcessId'>;
export type CredentialProfileId = Branded<string, 'CredentialProfileId'>;
export type TaskId = Branded<string, 'TaskId'>;
export type DeferredActionId = Branded<string, 'DeferredActionId'>;
export type SecretId = Branded<string, 'SecretId'>;
export type SiteReviewId = Branded<string, 'SiteReviewId'>;

function randomBase32(length: number): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function createId(prefix: keyof typeof PREFIXES): string {
  return `${PREFIXES[prefix]}_${randomBase32(26)}`;
}

export const ids = {
  tenant: () => createId('tenant') as TenantId,
  project: () => createId('project') as ProjectId,
  workspace: () => createId('workspace') as WorkspaceId,
  operation: () => createId('operation') as OperationId,
  approval: () => createId('approval') as ApprovalId,
  artifact: () => createId('artifact') as ArtifactId,
  preview: () => createId('preview') as PreviewId,
  process: () => createId('process') as ProcessId,
  credentialProfile: () => createId('credentialProfile') as CredentialProfileId,
  task: () => createId('task') as TaskId,
  deferred: () => createId('deferred') as DeferredActionId,
  secret: () => createId('secret') as SecretId,
  siteReview: () => createId('siteReview') as SiteReviewId
};

export function assertForgeId(value: string, prefix: string): void {
  if (!new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{20,32}$`).test(value)) {
    throw new Error(`Invalid Forge identifier for ${prefix}`);
  }
}

export async function workspaceIdFromIdempotency(scope: string, key: string): Promise<WorkspaceId> {
  const input = new TextEncoder().encode(`${scope}\0${key}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `ws_${hex.slice(0, 26)}` as WorkspaceId;
}
