import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  REPOSITORY_SLUG_CLEAR_SQL,
  REPOSITORY_UPSERT_SQL
} from '../../apps/forge-edge-gateway/src/github';

// Renaming a GitHub account rewrites the owner login on every repository. Forge
// stores repositories by (owner, name) but keys the row on GitHub's immutable
// numeric id, and the two disagreeing is what broke installation sync outright:
// the upsert conflicted on the mutable slug, matched nothing after a rename, and
// then hit the primary key with no handler — failing the whole atomic batch and
// leaving every stored owner stale.
//
// These run the real statements from github.ts against real SQLite, because the
// bug lived in ON CONFLICT resolution, which no hand-rolled D1 fake reproduces.
const SCHEMA = `CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  installation_id TEXT,
  authorization_state TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  github_repository_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  default_branch TEXT NOT NULL DEFAULT 'main',
  UNIQUE(provider, owner, name, tenant_id)
);`;

const TENANT = 'ten_1';

function harness() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  // Mirrors github.ts: the row id is a pure function of tenant + immutable repo id.
  const rowId = (githubRepoId: number) => `repo_${TENANT}_${githubRepoId}`;
  const sync = (owner: string, name: string, githubRepoId: number) => {
    db.prepare(REPOSITORY_SLUG_CLEAR_SQL).run(TENANT, owner, name, rowId(githubRepoId));
    db.prepare(REPOSITORY_UPSERT_SQL).run(
      rowId(githubRepoId), TENANT, 'prj_1', owner, name, '555',
      '2026-01-01T00:00:00.000Z', String(githubRepoId), 'private', 'main'
    );
  };
  const slugs = () => db
    .prepare('SELECT owner, name FROM repositories ORDER BY owner, name')
    .all()
    .map((row) => `${(row as { owner: string }).owner}/${(row as { name: string }).name}`);
  return { db, sync, slugs };
}

describe('repository sync across GitHub renames', () => {
  it('survives an account rename and moves the owner over', () => {
    const { sync, slugs } = harness();
    sync('oldname', 'app', 123);
    sync('oldname', 'site', 124);
    expect(slugs()).toEqual(['oldname/app', 'oldname/site']);

    // The rename: same repositories, same GitHub ids, new owner login. This is
    // the exact call that used to throw "UNIQUE constraint failed:
    // repositories.id" and take the whole installation sync down with it.
    expect(() => {
      sync('newname', 'app', 123);
      sync('newname', 'site', 124);
    }).not.toThrow();
    expect(slugs()).toEqual(['newname/app', 'newname/site']);
  });

  it('leaves no stale row behind at the old owner', () => {
    const { db, sync } = harness();
    sync('oldname', 'app', 123);
    sync('newname', 'app', 123);
    // One repository must stay one row: a duplicate at the old slug would keep
    // answering authorization lookups for a name that no longer exists.
    expect((db.prepare('SELECT COUNT(*) AS c FROM repositories').get() as { c: number }).c).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS c FROM repositories WHERE owner='oldname'").get()).toMatchObject({ c: 0 });
  });

  it('handles the repository itself being renamed', () => {
    const { sync, slugs } = harness();
    sync('acme', 'app', 123);
    sync('acme', 'application', 123);
    expect(slugs()).toEqual(['acme/application']);
  });

  it('handles a different repository claiming the freed name', () => {
    const { sync, slugs } = harness();
    sync('acme', 'app', 123);
    sync('acme', 'application', 123);
    // A brand new repository (different GitHub id) takes the vacated slug.
    sync('acme', 'app', 999);
    expect(slugs()).toEqual(['acme/app', 'acme/application']);
  });

  it('handles a repository transferred to another owner', () => {
    const { sync, slugs } = harness();
    sync('acme', 'app', 123);
    sync('newowner', 'app', 123);
    expect(slugs()).toEqual(['newowner/app']);
  });

  it('is idempotent when nothing changed', () => {
    const { db, sync, slugs } = harness();
    sync('acme', 'app', 123);
    sync('acme', 'app', 123);
    sync('acme', 'app', 123);
    expect(slugs()).toEqual(['acme/app']);
    expect((db.prepare('SELECT COUNT(*) AS c FROM repositories').get() as { c: number }).c).toBe(1);
  });

  it('re-authorizes a repository that had been revoked', () => {
    const { db, sync } = harness();
    sync('acme', 'app', 123);
    db.exec("UPDATE repositories SET authorization_state='revoked'");
    sync('acme', 'app', 123);
    expect(db.prepare('SELECT authorization_state AS s FROM repositories').get()).toMatchObject({ s: 'authorized' });
  });
});
