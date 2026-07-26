import { ForgeError } from '@forge/core';
import { listSlotOccupants, slotTtlMs } from './capacity';
import type { Env } from './env';

interface Identity { tenantId: string }

/**
 * Work out which workspace a call means when the caller did not say.
 *
 * An agent threads workspace_id through every call without effort. A chat
 * session does not: the id scrolls out of context, or a turn drops it, and from
 * then on every workspace tool fails — or worse, the model creates a second
 * workspace, burns a slot and leaves the first one running with the actual work
 * in it. Remembering an opaque identifier across turns is exactly the kind of
 * agency the client cannot supply, so Forge supplies it.
 *
 * Deliberately only resolves when there is no ambiguity at all: exactly one live
 * workspace for this tenant. With none, or several, it says so and names them
 * rather than guessing — acting on the wrong workspace is worse than asking.
 */
export async function resolveWorkspaceId(env: Env, identity: Identity, provided: unknown): Promise<string> {
  if (typeof provided === 'string' && provided.trim()) return provided.trim();
  const occupants = await listSlotOccupants(env.METADATA, slotTtlMs(env), Date.now(), identity.tenantId)
    .catch(() => [] as Awaited<ReturnType<typeof listSlotOccupants>>);
  const live = occupants.filter((occupant) => !['destroyed', 'failed'].includes(occupant.state ?? ''));
  if (live.length === 1) return live[0]!.workspaceId;
  if (live.length === 0) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'No workspace is open. Call forge_workspace_create first — it returns one ready to use — then this call will find it without needing the id.',
      retryable: false
    });
  }
  throw new ForgeError({
    code: 'FORGE_VALIDATION_FAILED',
    message: `Several workspaces are open, so this is ambiguous. Pass workspace_id explicitly — one of: ${live.map((occupant) => occupant.workspaceId).join(', ')}.`,
    retryable: false,
    details: { workspaces: live.map((occupant) => occupant.workspaceId) }
  });
}
