import { snapshotsEnabled } from './snapshots';

// deps_cache: a per-repo dependency cache in R2, keyed by CONTENT (repo slug +
// lockfile hash + runtime profile) rather than by workspace. Unlike the
// per-workspace snapshot, it is shared across every workspace of the same repo at
// the same lockfile — so even a FIRST-EVER create of a known repo can restore
// node_modules from R2 instead of a cold install.
//
// Like snapshots, the tar/untar runs INSIDE the workspace container; the Worker
// is only the authenticated R2 gateway at /__forge_deps/<workspaceId>. The whole
// feature reuses the FORGE_SNAPSHOT_ENABLED flag and is best-effort throughout.

// depsEnabled is an alias so callers can read intent locally; the flag itself is
// shared with the snapshot mechanism by design.
export const depsEnabled = snapshotsEnabled;

export interface DepsCacheKey {
  cacheKey: string;
  r2Key: string;
}

// The cache_key is the content identity SCOPED BY TENANT
// (tenantId|repoSlug|runtime|lockfileHash); the R2 key mirrors it as a path.
// node_modules trees contain executable code, so the tenantId component is a
// HARD security boundary: two tenants that clone the same public repo at the
// same lockfile must NEVER share a cached tree, or tenant B could execute a
// poisoned tree written by tenant A. tenantId/repoSlug contain no `|`, so the
// cacheKey and r2Key are losslessly interconvertible (see parseDepsCacheKey).
export function depsCacheKey(
  tenantId: string,
  repoSlug: string,
  lockfileHash: string,
  runtime: string
): DepsCacheKey {
  return {
    cacheKey: `${tenantId}|${repoSlug}|${runtime}|${lockfileHash}`,
    r2Key: `deps/${tenantId}/${repoSlug}/${runtime}/${lockfileHash}.tar.gz`
  };
}

// Reverse a cache_key back into its parts (and the R2 key) with strict
// validation, so an untrusted header value can never traverse outside deps/ nor
// cross a tenant boundary. Returns null on any malformed input.
export function parseDepsCacheKey(
  cacheKey: string
): { tenantId: string; repoSlug: string; runtime: string; lockfileHash: string; r2Key: string } | null {
  const parts = cacheKey.split('|');
  if (parts.length !== 4) return null;
  const [tenantId, repoSlug, runtime, lockfileHash] = parts as [string, string, string, string];
  // tenantId is an opaque forge id (e.g. `ten_...`): no `/`, `.` or `|`, so it
  // can neither traverse the R2 path nor collide with the delimiter.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) return null;
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repoSlug)) return null;
  // Reject `.`/`..` path segments so a cache key can never traverse outside deps/.
  if (repoSlug.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  if (!/^[a-z0-9][a-z0-9.-]{0,40}$/.test(runtime)) return null;
  if (!/^[a-f0-9]{64}$/.test(lockfileHash)) return null;
  return {
    tenantId,
    repoSlug,
    runtime,
    lockfileHash,
    r2Key: `deps/${tenantId}/${repoSlug}/${runtime}/${lockfileHash}.tar.gz`
  };
}

export interface DepsCacheRow {
  cache_key: string;
  repo_slug: string;
  lockfile_hash: string;
  runtime_profile: string;
  r2_key: string;
  size_bytes: number | null;
  created_at: string;
}

export async function recordDepsCache(
  db: D1Database,
  input: {
    cacheKey: string;
    repoSlug: string;
    lockfileHash: string;
    runtime: string;
    r2Key: string;
    sizeBytes: number;
    createdAt: string;
  }
): Promise<void> {
  await db.prepare(
    `INSERT OR REPLACE INTO workspace_deps_cache
       (cache_key, repo_slug, lockfile_hash, runtime_profile, r2_key, size_bytes, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(
    input.cacheKey,
    input.repoSlug,
    input.lockfileHash,
    input.runtime,
    input.r2Key,
    input.sizeBytes,
    input.createdAt
  ).run();
}

export async function getDepsCache(db: D1Database, cacheKey: string): Promise<DepsCacheRow | null> {
  return db.prepare(
    'SELECT cache_key, repo_slug, lockfile_hash, runtime_profile, r2_key, size_bytes, created_at FROM workspace_deps_cache WHERE cache_key = ?1'
  ).bind(cacheKey).first<DepsCacheRow>();
}
