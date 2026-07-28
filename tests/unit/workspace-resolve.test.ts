import { describe, expect, it } from 'vitest';
import { parseWorkspaceAddress, resolveWorkspaceId } from '../../apps/forge-edge-gateway/src/workspace-resolve';
import type { Env } from '../../apps/forge-edge-gateway/src/env';

// A chat client cannot be relied on to carry an opaque workspace id across
// turns, so Forge resolves which workspace a call means from a single
// `workspace` field — "owner/repo#branch", "owner/repo", or a bare branch —
// instead of three separate owner/repo/branch fields (which cost ~3x the
// wire bytes for the same information, re-sent every turn). The whole value
// of resolution depends on it never guessing: acting on the wrong workspace
// is far worse than telling the caller to be explicit.

const WS_A = 'ws_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const WS_B = 'ws_bbbbbbbbbbbbbbbbbbbbbbbbbb';

interface Occupant {
  workspaceId: string;
  state?: string;
  owner?: string;
  repo?: string;
  branch?: string | null;
}

function envWith(occupants: Occupant[], options: { throws?: boolean } = {}) {
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
                updated_at: new Date().toISOString(),
                repository: occupant.owner && occupant.repo ? `${occupant.owner}/${occupant.repo}` : null,
                current_branch: occupant.branch === undefined ? null : occupant.branch
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

describe('parsing the workspace field', () => {
  it('parses "owner/repo#branch"', () => {
    expect(parseWorkspaceAddress('acme/webapp#forge/fix-login')).toEqual({
      owner: 'acme',
      repo: 'webapp',
      branch: 'forge/fix-login'
    });
  });

  it('parses a bare "owner/repo" with no branch', () => {
    expect(parseWorkspaceAddress('acme/webapp')).toEqual({ owner: 'acme', repo: 'webapp' });
  });

  it('parses a bare branch (starts with forge/, no #)', () => {
    expect(parseWorkspaceAddress('forge/fix-login')).toEqual({ branch: 'forge/fix-login' });
  });

  it('splits on the LAST # — a branch can never contain one itself (assertForgeBranch\'s charset excludes it), so only a malformed input can even show the difference', () => {
    // If this split on the FIRST # instead, repo would be "webapp" and branch
    // would be "part1#part2". Splitting on the LAST # instead gives the repo
    // half everything up to the last #, which is what the parser actually
    // does — demonstrated here with an input that is not a realistic address
    // (a real repo name never contains #) but pins the split point precisely.
    expect(parseWorkspaceAddress('acme/webapp#part1#part2')).toEqual({
      owner: 'acme',
      repo: 'webapp#part1',
      branch: 'part2'
    });
  });

  it('rejects a malformed value with the accepted forms and an example, not a regex', () => {
    expect(() => parseWorkspaceAddress('not-a-valid-address')).toThrowError(/owner\/repo#branch/);
    try {
      parseWorkspaceAddress('not-a-valid-address');
      throw new Error('expected a throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('"owner/repo#branch"');
      expect(message).toContain('"owner/repo"');
      expect(message).toContain('forge/fix-login');
      expect(message).toContain('not-a-valid-address');
      expect(message).not.toMatch(/\^|\$|\\d|\\w/); // reads like prose, not a regex dump
    }
  });

  it('rejects "owner/repo#" (empty branch after #)', () => {
    expect(() => parseWorkspaceAddress('acme/webapp#')).toThrow();
  });

  it('rejects "#branch" (empty repo half before #)', () => {
    expect(() => parseWorkspaceAddress('#forge/fix-login')).toThrow();
  });
});

describe('resolving which workspace a call means', () => {
  it('uses an explicit workspace_id, without going near the database — the forge_artifact_get / url-review path', async () => {
    // An explicit id must always win, even when it disagrees with what is
    // open. This is the one field that stayed a raw id (see wsid() in
    // packages/mcp-core), for forge_review's synthetic workspaces which have
    // no repository or branch to be addressed by at all.
    const env = envWith([{ workspaceId: WS_B }]);
    expect(await resolveWorkspaceId(env, identity, { workspaceId: WS_A })).toBe(WS_A);
  });

  it('resolves the single open workspace when nothing is given', async () => {
    const env = envWith([{ workspaceId: WS_A, owner: 'acme', repo: 'webapp', branch: 'forge/fix-login' }]);
    for (const empty of [{}, { workspace: undefined }]) {
      expect(await resolveWorkspaceId(env, identity, empty)).toBe(WS_A);
    }
  });

  it('resolves by branch alone when it is unambiguous', async () => {
    const env = envWith([
      { workspaceId: WS_A, owner: 'acme', repo: 'webapp', branch: 'forge/fix-login' },
      { workspaceId: WS_B, owner: 'acme', repo: 'api', branch: 'forge/other-thing' }
    ]);
    expect(await resolveWorkspaceId(env, identity, { workspace: 'forge/fix-login' })).toBe(WS_A);
  });

  it('resolves "owner/repo#branch" — all three at once', async () => {
    const env = envWith([
      { workspaceId: WS_A, owner: 'acme', repo: 'webapp', branch: 'forge/fix-login' },
      { workspaceId: WS_B, owner: 'acme', repo: 'webapp', branch: 'forge/other-thing' }
    ]);
    expect(await resolveWorkspaceId(env, identity, { workspace: 'acme/webapp#forge/fix-login' })).toBe(WS_A);
  });

  it('resolves "owner/repo" with no branch when it is unambiguous', async () => {
    const env = envWith([
      { workspaceId: WS_A, owner: 'acme', repo: 'webapp', branch: 'forge/fix-login' },
      { workspaceId: WS_B, owner: 'acme', repo: 'api', branch: 'forge/other-thing' }
    ]);
    expect(await resolveWorkspaceId(env, identity, { workspace: 'acme/webapp' })).toBe(WS_A);
  });

  it('refuses to guess when several workspaces are open with nothing to narrow by, and names them as owner/repo on branch — never as a ws_... id', async () => {
    const env = envWith([
      { workspaceId: WS_A, owner: 'acme', repo: 'webapp', branch: 'forge/fix-login' },
      { workspaceId: WS_B, owner: 'acme', repo: 'api', branch: 'forge/other-thing' }
    ]);
    await expect(resolveWorkspaceId(env, identity, {})).rejects.toMatchObject({
      code: 'FORGE_VALIDATION_FAILED'
    });
    await resolveWorkspaceId(env, identity, {}).catch((error: Error) => {
      // The caller has to be able to act on this without another round trip —
      // and without an id it has already lost.
      expect(error.message).toContain('acme/webapp on forge/fix-login');
      expect(error.message).toContain('acme/api on forge/other-thing');
      expect(error.message).not.toMatch(/ws_[0-9a-z]/);
    });
  });

  it('refuses to guess when branch alone still matches more than one workspace', async () => {
    const env = envWith([
      { workspaceId: WS_A, owner: 'acme', repo: 'webapp', branch: 'forge/shared-name' },
      { workspaceId: WS_B, owner: 'acme', repo: 'api', branch: 'forge/shared-name' }
    ]);
    await expect(resolveWorkspaceId(env, identity, { workspace: 'forge/shared-name' })).rejects.toMatchObject({
      code: 'FORGE_VALIDATION_FAILED'
    });
  });

  it('ignores workspaces that are already gone (terminal states), so a destroyed slot never makes a live one look ambiguous', async () => {
    const env = envWith([
      { workspaceId: WS_A, owner: 'acme', repo: 'webapp', branch: 'forge/fix-login', state: 'ready' },
      { workspaceId: WS_B, owner: 'acme', repo: 'webapp', branch: 'forge/other', state: 'destroyed' }
    ]);
    expect(await resolveWorkspaceId(env, identity, {})).toBe(WS_A);
  });

  it('treats every non-terminal state as live, not only "ready"', async () => {
    // provisioning/bootstrapping/requested are all live — only
    // suspended/failed/destroying/destroyed are excluded (capacity.ts's
    // TERMINAL_STATES, imported rather than redefined).
    const env = envWith([{ workspaceId: WS_A, owner: 'acme', repo: 'webapp', branch: 'forge/fix-login', state: 'provisioning' }]);
    expect(await resolveWorkspaceId(env, identity, {})).toBe(WS_A);
  });

  it('says to create one when nothing is open at all', async () => {
    await expect(resolveWorkspaceId(envWith([]), identity, {})).rejects.toMatchObject({
      code: 'FORGE_VALIDATION_FAILED'
    });
    await resolveWorkspaceId(envWith([]), identity, {}).catch((error: Error) => {
      expect(error.message).toContain('forge_workspace_create');
    });
  });

  it('says no live workspace matches, and names what was searched for, when a given address matches nothing', async () => {
    const env = envWith([{ workspaceId: WS_A, owner: 'acme', repo: 'webapp', branch: 'forge/fix-login' }]);
    await resolveWorkspaceId(env, identity, { workspace: 'acme/other-repo' }).catch((error: Error) => {
      expect(error.message).toContain('acme/other-repo');
      expect(error.message).toContain('forge_observer_workspaces');
    });
  });

  it('rejects a malformed workspace value before touching the database', async () => {
    const env = envWith([{ workspaceId: WS_A }], { throws: true });
    await expect(resolveWorkspaceId(env, identity, { workspace: 'not-a-valid-address' })).rejects.toMatchObject({
      code: 'FORGE_VALIDATION_FAILED'
    });
  });

  it('treats a lookup failure as "nothing open" rather than crashing the call', async () => {
    await expect(
      resolveWorkspaceId(envWith([{ workspaceId: WS_A }], { throws: true }), identity, {})
    ).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
  });
});
