import { workspaceIdFromIdempotency } from '@forge/core';

/** Stable when the caller supplied a retry key; unique when it did not. */
export async function forgeStartSlug(input: {
  tenantId: string;
  projectId: string;
  owner: string;
  repo: string;
  idempotencyKey?: string;
  randomKey?: () => string;
}): Promise<string> {
  const scope = `${input.tenantId}:${input.projectId}:${input.owner.toLowerCase()}/${input.repo.toLowerCase()}`;
  const key = input.idempotencyKey ?? (input.randomKey ?? crypto.randomUUID)();
  return (await workspaceIdFromIdempotency(scope, key)).replace(/^ws_/u, '').slice(0, 16);
}
