import { describe, expect, it } from 'vitest';
import {
  depsCacheKey,
  depsEnabled,
  getDepsCache,
  parseDepsCacheKey,
  recordDepsCache,
  type DepsCacheRow
} from '../../apps/forge-edge-gateway/src/deps-cache';

// Minimal in-memory D1 that understands only the statements deps-cache.ts issues:
// an INSERT OR REPLACE into workspace_deps_cache and a single-row read by
// cache_key.
function fakeD1(rows: DepsCacheRow[] = []) {
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
          if (sql.startsWith('INSERT OR REPLACE INTO workspace_deps_cache')) {
            const [cache_key, repo_slug, lockfile_hash, runtime_profile, r2_key, size_bytes, created_at] =
              values as [string, string, string, string, string, number, string];
            const row: DepsCacheRow = { cache_key, repo_slug, lockfile_hash, runtime_profile, r2_key, size_bytes, created_at };
            const existing = rows.find((r) => r.cache_key === cache_key);
            if (existing) Object.assign(existing, row);
            else rows.push(row);
          }
          return { meta: { changes: 1 } };
        },
        async first<T>() {
          if (sql.startsWith('SELECT') && sql.includes('workspace_deps_cache')) {
            return (rows.find((r) => r.cache_key === values[0]) ?? null) as T | null;
          }
          return null;
        }
      };
    }
  } as unknown as D1Database & { rows: DepsCacheRow[] };
}

const HASH = 'a'.repeat(64);

describe('deps-cache', () => {
  it('reuses the snapshot flag to gate the feature', () => {
    expect(depsEnabled({})).toBe(false);
    expect(depsEnabled({ FORGE_SNAPSHOT_ENABLED: 'true' })).toBe(true);
    expect(depsEnabled({ FORGE_SNAPSHOT_ENABLED: '1' })).toBe(true);
  });

  it('keys by repo, runtime and lockfile hash', () => {
    const { cacheKey, r2Key } = depsCacheKey('acme/widgets', HASH, 'node-22');
    expect(cacheKey).toBe(`acme/widgets|node-22|${HASH}`);
    expect(r2Key).toBe(`deps/acme/widgets/node-22/${HASH}.tar.gz`);
  });

  it('round-trips a cache key back into its parts and R2 key', () => {
    const { cacheKey, r2Key } = depsCacheKey('acme/widgets', HASH, 'node-22');
    const parsed = parseDepsCacheKey(cacheKey);
    expect(parsed).toEqual({ repoSlug: 'acme/widgets', runtime: 'node-22', lockfileHash: HASH, r2Key });
  });

  it('rejects malformed or traversal-prone cache keys', () => {
    expect(parseDepsCacheKey('acme/widgets|node-22')).toBeNull();
    expect(parseDepsCacheKey('acme/widgets|node-22|nothex')).toBeNull();
    expect(parseDepsCacheKey(`../evil|node-22|${HASH}`)).toBeNull();
    expect(parseDepsCacheKey(`acme/widgets|../x|${HASH}`)).toBeNull();
  });

  it('records a cache entry and reads it back', async () => {
    const db = fakeD1();
    const { cacheKey, r2Key } = depsCacheKey('acme/widgets', HASH, 'node-22');
    expect(await getDepsCache(db, cacheKey)).toBeNull();
    await recordDepsCache(db, {
      cacheKey,
      repoSlug: 'acme/widgets',
      lockfileHash: HASH,
      runtime: 'node-22',
      r2Key,
      sizeBytes: 4096,
      createdAt: '2026-07-19T12:00:00.000Z'
    });
    const row = await getDepsCache(db, cacheKey);
    expect(row).toMatchObject({ cache_key: cacheKey, repo_slug: 'acme/widgets', runtime_profile: 'node-22', size_bytes: 4096 });
  });

  it('replaces an existing entry in place', async () => {
    const db = fakeD1();
    const { cacheKey, r2Key } = depsCacheKey('acme/widgets', HASH, 'node-22');
    const base = { cacheKey, repoSlug: 'acme/widgets', lockfileHash: HASH, runtime: 'node-22', r2Key };
    await recordDepsCache(db, { ...base, sizeBytes: 10, createdAt: '2026-07-19T12:00:00.000Z' });
    await recordDepsCache(db, { ...base, sizeBytes: 99, createdAt: '2026-07-19T13:00:00.000Z' });
    expect(db.rows.length).toBe(1);
    expect(await getDepsCache(db, cacheKey)).toMatchObject({ size_bytes: 99, created_at: '2026-07-19T13:00:00.000Z' });
  });
});
