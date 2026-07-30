import { ForgeError } from '@forge/core';
import type { Env } from './env';

type ExternalMutationClaim =
  | { kind: 'claimed'; ownerToken: string }
  | { kind: 'replay'; receipt: Record<string, unknown> };

export async function readExternalMutationReceipt(
  env: Pick<Env, 'METADATA'>,
  input: { tenantId: string; scope: string; idempotencyKey: string; intentHash: string }
): Promise<Record<string, unknown> | null> {
  const row = await env.METADATA.prepare(
    `SELECT intent_hash, receipt_json
       FROM external_mutation_receipts
      WHERE tenant_id=?1 AND scope=?2 AND idempotency_key=?3`
  ).bind(input.tenantId, input.scope, input.idempotencyKey)
    .first<{ intent_hash: string; receipt_json: string | null }>();
  if (!row) return null;
  if (row.intent_hash !== input.intentHash) {
    throw new ForgeError({
      code: 'FORGE_WORKSPACE_CONFLICT',
      message: 'Forge refused this pull-request mutation because its idempotency key is already bound to a different intent. Retry the original action and arguments, or use a fresh key for the new intent.',
      retryable: false
    });
  }
  if (row.receipt_json) return JSON.parse(row.receipt_json) as Record<string, unknown>;
  throw new ForgeError({
    code: 'FORGE_WORKSPACE_CONFLICT',
    message: 'The same pull-request mutation is already in progress, so Forge did not execute it twice. Retry this exact call with the same idempotency key after the first attempt finishes.',
    retryable: true
  });
}

/** Claim one external mutation intent, or replay its stored receipt. */
export async function claimExternalMutation(
  env: Pick<Env, 'METADATA'>,
  input: { tenantId: string; scope: string; idempotencyKey: string; intentHash: string }
): Promise<ExternalMutationClaim> {
  const ownerToken = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.METADATA.prepare(
    `INSERT OR IGNORE INTO external_mutation_receipts
      (tenant_id, scope, idempotency_key, intent_hash, owner_token, claimed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(input.tenantId, input.scope, input.idempotencyKey, input.intentHash, ownerToken, now).run();

  const read = () => env.METADATA.prepare(
    `SELECT intent_hash, owner_token, claimed_at, receipt_json
       FROM external_mutation_receipts
      WHERE tenant_id=?1 AND scope=?2 AND idempotency_key=?3`
  ).bind(input.tenantId, input.scope, input.idempotencyKey)
    .first<{ intent_hash: string; owner_token: string; claimed_at: string; receipt_json: string | null }>();

  let row = await read();
  if (!row) throw new Error('External mutation claim disappeared after insertion.');
  if (row.intent_hash !== input.intentHash) {
    throw new ForgeError({
      code: 'FORGE_WORKSPACE_CONFLICT',
      message: 'Forge refused this pull-request mutation because its idempotency key is already bound to a different intent. Retry the original action and arguments, or use a fresh key for the new intent.',
      retryable: false
    });
  }
  if (row.receipt_json) return { kind: 'replay', receipt: JSON.parse(row.receipt_json) as Record<string, unknown> };
  if (row.owner_token === ownerToken) return { kind: 'claimed', ownerToken };

  // A request may die after claiming but before GitHub answers. Allow the same
  // intent to recover that orphan after two minutes; a different intent can
  // never take the key because the hash check above is permanent.
  if (Date.parse(row.claimed_at) < Date.now() - 120_000) {
    await env.METADATA.prepare(
      `UPDATE external_mutation_receipts
          SET owner_token=?1, claimed_at=?2
        WHERE tenant_id=?3 AND scope=?4 AND idempotency_key=?5
          AND intent_hash=?6 AND receipt_json IS NULL AND claimed_at=?7`
    ).bind(ownerToken, now, input.tenantId, input.scope, input.idempotencyKey, input.intentHash, row.claimed_at).run();
    row = await read();
    if (row?.owner_token === ownerToken) return { kind: 'claimed', ownerToken };
    if (row?.receipt_json) return { kind: 'replay', receipt: JSON.parse(row.receipt_json) as Record<string, unknown> };
  }

  throw new ForgeError({
    code: 'FORGE_WORKSPACE_CONFLICT',
    message: 'The same pull-request mutation is already in progress, so Forge did not execute it twice. Retry this exact call with the same idempotency key after the first attempt finishes.',
    retryable: true
  });
}

export async function recordExternalMutationReceipt(
  env: Pick<Env, 'METADATA'>,
  input: { tenantId: string; scope: string; idempotencyKey: string; ownerToken: string; receipt: Record<string, unknown> }
): Promise<void> {
  await env.METADATA.prepare(
    `UPDATE external_mutation_receipts
        SET receipt_json=?1, completed_at=?2
      WHERE tenant_id=?3 AND scope=?4 AND idempotency_key=?5 AND owner_token=?6`
  ).bind(
    JSON.stringify(input.receipt),
    new Date().toISOString(),
    input.tenantId,
    input.scope,
    input.idempotencyKey,
    input.ownerToken
  ).run();
}
