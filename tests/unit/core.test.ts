import { describe, expect, it } from 'vitest';
import {
  ForgeError,
  assertForgeId,
  assertWorkspaceTransition,
  ids,
  nextRevision,
  workspaceIdFromIdempotency
} from '@forge/core';

describe('Forge core invariants', () => {
  it('creates valid branded identifiers', () => {
    const workspace = ids.workspace();
    expect(() => assertForgeId(workspace, 'ws')).not.toThrow();
  });

  it('derives stable workspace IDs from idempotency scope', async () => {
    const first = await workspaceIdFromIdempotency('tenant/project', 'request-123456');
    const second = await workspaceIdFromIdempotency('tenant/project', 'request-123456');
    const different = await workspaceIdFromIdempotency('tenant/project', 'request-654321');
    expect(first).toBe(second);
    expect(first).not.toBe(different);
    expect(first).toMatch(/^ws_[0-9a-f]{26}$/);
  });

  it('rejects invalid lifecycle transitions', () => {
    expect(() => assertWorkspaceTransition('requested', 'ready')).toThrow(ForgeError);
    expect(() => assertWorkspaceTransition('requested', 'provisioning')).not.toThrow();
  });

  it('enforces optimistic revisions', () => {
    expect(nextRevision(4, 4)).toBe(5);
    expect(() => nextRevision(4, 3)).toThrowError(
      expect.objectContaining({ code: 'FORGE_STALE_REVISION' })
    );
  });
});
