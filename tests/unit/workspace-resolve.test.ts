import { describe, expect, it } from 'vitest';
import { resolveWorkspaceId } from '../../apps/forge-edge-gateway/src/workspace-resolve';
import type { Env } from '../../apps/forge-edge-gateway/src/env';

// A chat client cannot be relied on to carry an opaque workspace id across
// turns, so Forge works out which workspace a call means. The whole value of
// that depends on it never guessing: acting on the wrong workspace is far worse
// than telling the caller to be explicit.

const WS_A = 'ws_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const WS_B = 'ws_bbbbbbbbbbbbbbbbbbbbbbbbbb';

function envWith(occupants: Array<{ workspaceId: string; state?: string }>, options: { throws?: boolean } = {}) {
  return {
    FORGE_SLOT_TTL_MINUTES: '240',
    METADATA: {
      prepare() {
        const statement: Record<string, unknown> = {
          bind: () => statement,
          all: async () => {
            if (options.throws) throw new Error('D1 unavailable');
            return {
              results: occupants.map((occupant, index) => ({
                slot: index + 1,
                workspace_id: occupant.workspaceId,
                tenant_id: 'ten_a',
                claimed_at: new Date().toISOString(),
                state: occupant.state ?? 'ready',
                updated_at: new Date().toISOString()
              }))
            };
          },
          first: async () => null,
          run: async () => ({ meta: { changes: 0 } })
        };
        return statement;
      }
    }
  } as unknown as Env;
}

const identity = { tenantId: 'ten_a' };

describe('resolving which workspace a call means', () => {
  it('uses what the caller gave, without going near the database', async () => {
    // An explicit id must always win, even when it disagrees with what is open —
    // an agent that threads ids correctly must not be second-guessed.
    const env = envWith([{ workspaceId: WS_B }]);
    expect(await resolveWorkspaceId(env, identity, WS_A)).toBe(WS_A);
  });

  it('finds the single open workspace when the caller lost the id', async () => {
    const env = envWith([{ workspaceId: WS_A }]);
    for (const missing of [undefined, null, '', '   ']) {
      expect(await resolveWorkspaceId(env, identity, missing)).toBe(WS_A);
    }
  });

  it('refuses to guess when several are open, and names them', async () => {
    const env = envWith([{ workspaceId: WS_A }, { workspaceId: WS_B }]);
    await expect(resolveWorkspaceId(env, identity, undefined)).rejects.toMatchObject({
      code: 'FORGE_VALIDATION_FAILED'
    });
    await resolveWorkspaceId(env, identity, undefined).catch((error: Error) => {
      // The caller has to be able to act on this without another round trip.
      expect(error.message).toContain(WS_A);
      expect(error.message).toContain(WS_B);
    });
  });

  it('ignores workspaces that are already gone', async () => {
    // A destroyed or failed slot must not make a live one look ambiguous, or a
    // session goes unusable until someone cleans up rows it cannot see.
    const env = envWith([
      { workspaceId: WS_A, state: 'ready' },
      { workspaceId: WS_B, state: 'destroyed' }
    ]);
    expect(await resolveWorkspaceId(env, identity, undefined)).toBe(WS_A);
  });

  it('says to create one when nothing is open', async () => {
    await expect(resolveWorkspaceId(envWith([]), identity, undefined)).rejects.toMatchObject({
      code: 'FORGE_VALIDATION_FAILED'
    });
    await resolveWorkspaceId(envWith([]), identity, undefined).catch((error: Error) => {
      expect(error.message).toContain('forge_workspace_create');
    });
  });

  it('treats a lookup failure as "nothing open" rather than crashing the call', async () => {
    await expect(
      resolveWorkspaceId(envWith([{ workspaceId: WS_A }], { throws: true }), identity, undefined)
    ).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
  });
});
