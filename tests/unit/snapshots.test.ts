import { describe, expect, it } from 'vitest';
import {
  getSnapshot,
  recordSnapshot,
  snapshotKey,
  snapshotsEnabled,
  type SnapshotIndexRow
} from '../../apps/forge-edge-gateway/src/snapshots';

// Minimal in-memory D1 that understands only the statements snapshots.ts issues:
// an upsert into workspace_snapshots and a single-row read by workspace_id.
function fakeD1(rows: SnapshotIndexRow[] = []) {
  return {
    rows,
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...input: unknown[]) {
          values = input;
          return this;
        },
        async run() {
          if (sql.startsWith('INSERT INTO workspace_snapshots')) {
            const [workspace_id, tenant_id, r2_key, size_bytes, created_at] = values as [
              string,
              string,
              string,
              number,
              string
            ];
            const existing = rows.find((r) => r.workspace_id === workspace_id);
            if (existing) Object.assign(existing, { r2_key, size_bytes, created_at });
            else rows.push({ workspace_id, tenant_id, r2_key, size_bytes, created_at });
          }
          return { meta: { changes: 1 } };
        },
        async first<T>() {
          if (sql.startsWith('SELECT') && sql.includes('workspace_snapshots')) {
            return (rows.find((r) => r.workspace_id === values[0]) ?? null) as T | null;
          }
          return null;
        }
      };
    }
  } as unknown as D1Database & { rows: SnapshotIndexRow[] };
}

describe('snapshots', () => {
  it('is disabled unless the flag is explicitly on', () => {
    expect(snapshotsEnabled({})).toBe(false);
    expect(snapshotsEnabled({ FORGE_SNAPSHOT_ENABLED: 'false' })).toBe(false);
    expect(snapshotsEnabled({ FORGE_SNAPSHOT_ENABLED: '0' })).toBe(false);
    expect(snapshotsEnabled({ FORGE_SNAPSHOT_ENABLED: 'true' })).toBe(true);
    expect(snapshotsEnabled({ FORGE_SNAPSHOT_ENABLED: '1' })).toBe(true);
  });

  it('scopes the R2 key by tenant and workspace', () => {
    expect(snapshotKey('ten_a', 'wsp_1')).toBe('snapshots/ten_a/wsp_1.tar.gz');
  });

  it('records a snapshot and reads it back', async () => {
    const db = fakeD1();
    expect(await getSnapshot(db, 'wsp_1')).toBeNull();
    await recordSnapshot(db, {
      workspaceId: 'wsp_1',
      tenantId: 'ten_a',
      r2Key: snapshotKey('ten_a', 'wsp_1'),
      sizeBytes: 1234,
      createdAt: '2026-07-19T12:00:00.000Z'
    });
    const row = await getSnapshot(db, 'wsp_1');
    expect(row).toMatchObject({ workspace_id: 'wsp_1', tenant_id: 'ten_a', size_bytes: 1234 });
  });

  it('upserts an existing snapshot in place', async () => {
    const db = fakeD1();
    const base = { workspaceId: 'wsp_1', tenantId: 'ten_a', r2Key: snapshotKey('ten_a', 'wsp_1') };
    await recordSnapshot(db, { ...base, sizeBytes: 10, createdAt: '2026-07-19T12:00:00.000Z' });
    await recordSnapshot(db, { ...base, sizeBytes: 99, createdAt: '2026-07-19T13:00:00.000Z' });
    expect(db.rows.length).toBe(1);
    expect(await getSnapshot(db, 'wsp_1')).toMatchObject({ size_bytes: 99, created_at: '2026-07-19T13:00:00.000Z' });
  });
});
