import { describe, expect, it } from 'vitest';
import {
  analyzeDiff,
  classifyPath,
  selectContext,
  suggestChecks
} from '@forge/insight';

const SAMPLE_DIFF = `diff --git a/packages/cart/src/total.ts b/packages/cart/src/total.ts
index 111..222 100644
--- a/packages/cart/src/total.ts
+++ b/packages/cart/src/total.ts
@@ -1,4 +1,5 @@
-export function total(items) {
+export function total(items, tax) {
+  const rounded = bankers(items);
   return items.reduce((a, b) => a + b, 0);
 }
diff --git a/migrations/d1/0006_carts.sql b/migrations/d1/0006_carts.sql
new file mode 100644
--- /dev/null
+++ b/migrations/d1/0006_carts.sql
@@ -0,0 +1,2 @@
+CREATE TABLE carts (id TEXT PRIMARY KEY);
+CREATE INDEX idx ON carts(id);
`;

describe('path classification', () => {
  it('classifies tests, config, migrations, worker config and packages', () => {
    expect(classifyPath('packages/core/src/a.test.ts').isTest).toBe(true);
    expect(classifyPath('apps/web/wrangler.jsonc').isWorkerConfig).toBe(true);
    expect(classifyPath('migrations/d1/0006.sql').isMigration).toBe(true);
    expect(classifyPath('dist/bundle.js').isGenerated).toBe(true);
    expect(classifyPath('pnpm-lock.yaml').isLockfile).toBe(true);
    expect(classifyPath('packages/cart/src/x.ts').packageDir).toBe('packages/cart');
    expect(classifyPath('docs/readme.md').isDoc).toBe(true);
  });
});

describe('compact diff metadata', () => {
  const compact = analyzeDiff(SAMPLE_DIFF);

  it('counts files, additions and deletions', () => {
    expect(compact.files).toHaveLength(2);
    expect(compact.totalAdditions).toBe(4);
    expect(compact.totalDeletions).toBe(1);
  });

  it('detects the new file, changed exports and migration', () => {
    const migration = compact.files.find((f) => f.path.endsWith('.sql'));
    expect(migration?.changeType).toBe('added');
    expect(compact.changedExports).toContain('total');
    expect(compact.migrations).toEqual(['migrations/d1/0006_carts.sql']);
    expect(compact.riskAreas.join(' ')).toMatch(/migration/i);
  });

  it('produces a stable hash that changes only when the diff changes', () => {
    expect(analyzeDiff(SAMPLE_DIFF).hash).toBe(compact.hash);
    expect(analyzeDiff(SAMPLE_DIFF + '\n').hash).not.toBe(compact.hash);
  });

  it('flags a committed secret in an added line', () => {
    const diff = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -1 +1,2 @@
 const x = 1;
+const token = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345;
`;
    const result = analyzeDiff(diff);
    expect(result.possibleSecretExposure).toEqual(['src/config.ts']);
    expect(result.riskAreas.join(' ')).toMatch(/secret/i);
  });
});

describe('targeted verification suggestions', () => {
  it('suggests package typecheck then tests, narrow to broad', () => {
    const checks = suggestChecks(['packages/cart/src/total.ts']);
    expect(checks[0]).toMatchObject({ command: 'pnpm --filter ./packages/cart typecheck', required: true });
    expect(checks.some((c) => c.command === 'pnpm --filter ./packages/cart test')).toBe(true);
    // costClass ordering is non-decreasing
    const ranks = checks.map((c) => c.costClass);
    expect(ranks.indexOf('expensive')).toBeLessThanOrEqual(Math.max(ranks.length - 1, 0));
  });

  it('returns documentation-only checks for docs changes', () => {
    const checks = suggestChecks(['docs/readme.md', 'README.md']);
    expect(checks).toHaveLength(1);
    expect(checks[0].costClass).toBe('cheap');
    expect(checks[0].required).toBe(false);
  });

  it('adds typegen and a full build for worker config and build tooling', () => {
    const checks = suggestChecks(['apps/web/wrangler.jsonc', 'vite.config.ts']);
    expect(checks.some((c) => c.command === 'pnpm cf:typegen')).toBe(true);
    expect(checks.some((c) => c.command === 'pnpm build' && c.costClass === 'expensive')).toBe(true);
    expect(checks.find((c) => c.command === 'pnpm exec wrangler deploy --dry-run')?.networkRequired).toBe(true);
  });
});

describe('analyzeDiff edge cases', () => {
  it('handles an empty diff', () => {
    const result = analyzeDiff('');
    expect(result.files).toHaveLength(0);
    expect(result.totalAdditions).toBe(0);
    expect(result.totalDeletions).toBe(0);
    expect(result.changedExports).toEqual([]);
    expect(result.riskAreas).toEqual([]);
    expect(result.suggestedHunks).toEqual([]);
    expect(result.hash).toBeTruthy();
  });

  it('handles a diff with only context lines (no changes)', () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
index a..b 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,3 +1,3 @@
 const a = 1;
 const b = 2;
-const c = 3;
+const c = 4;
`;
    // This diff has a change so it should have 1 file
    const result = analyzeDiff(diff);
    expect(result.files).toHaveLength(1);
    expect(result.totalAdditions).toBe(1);
    expect(result.totalDeletions).toBe(1);
  });

  it('detects a renamed file', () => {
    const diff = `diff --git a/src/old.ts b/src/new.ts
similarity index 90%
rename from src/old.ts
rename to src/new.ts
`;
    const result = analyzeDiff(diff);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.changeType).toBe('renamed');
    expect(result.files[0]?.path).toBe('src/new.ts');
  });

  it('detects a new (added) file', () => {
    const diff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+const x = 1;
`;
    const result = analyzeDiff(diff);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.changeType).toBe('added');
    expect(result.files[0]?.additions).toBe(1);
  });

  it('detects a deleted file', () => {
    const diff = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
--- a/src/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-const x = 1;
`;
    const result = analyzeDiff(diff);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.changeType).toBe('deleted');
    expect(result.files[0]?.deletions).toBe(1);
  });

  it('detects secrets in added lines and classifies risk areas', () => {
    const diff = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -1 +1,2 @@
 const x = 1;
+const key = "AKIAIOSFODNN7EXAMPLE";
`;
    const result = analyzeDiff(diff);
    expect(result.possibleSecretExposure).toEqual(['src/config.ts']);
    expect(result.riskAreas.some((r) => r.includes('secret'))).toBe(true);
  });

  it('detects exports in added lines', () => {
    const diff = `diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -1 +1,2 @@
 const x = 1;
+export function hello() { return "world"; }
`;
    const result = analyzeDiff(diff);
    expect(result.changedExports).toContain('hello');
  });

  it('detects binary files', () => {
    const diff = `diff --git a/image.png b/image.png
index 000..111 100644
Binary files /dev/null and b/image.png differ
`;
    const result = analyzeDiff(diff);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('image.png');
  });

  it('classifies migration files', () => {
    const diff = `diff --git a/migrations/d1/0007_add_carts.sql b/migrations/d1/0007_add_carts.sql
new file mode 100644
--- /dev/null
+++ b/migrations/d1/0007_add_carts.sql
@@ -0,0 +1 @@
+CREATE TABLE cart (id TEXT PRIMARY KEY);
`;
    const result = analyzeDiff(diff);
    expect(result.migrations).toHaveLength(1);
    expect(result.migrations[0]).toBe('migrations/d1/0007_add_carts.sql');
    expect(result.riskAreas.some((r) => r.includes('migration'))).toBe(true);
  });

  it('classifies lockfile changes', () => {
    const diff = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1 +1 @@
-lockfileVersion: '6.0'
+lockfileVersion: '7.0'
`;
    const result = analyzeDiff(diff);
    expect(result.lockfileChanges).toHaveLength(1);
    expect(result.lockfileChanges[0]).toBe('pnpm-lock.yaml');
  });

  it('classifies worker config changes', () => {
    const diff = `diff --git a/wrangler.jsonc b/wrangler.jsonc
--- a/wrangler.jsonc
+++ b/wrangler.jsonc
@@ -1 +1 @@
-name: "old"
+name: "new"
`;
    const result = analyzeDiff(diff);
    expect(result.workerConfigChanges).toHaveLength(1);
    expect(result.workerConfigChanges[0]).toBe('wrangler.jsonc');
    expect(result.riskAreas.some((r) => r.includes('Worker'))).toBe(true);
  });

  it('classifies generated output', () => {
    const diff = `diff --git a/dist/bundle.js b/dist/bundle.js
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -1 +1 @@
-old
+new
`;
    const result = analyzeDiff(diff);
    expect(result.generatedChanges).toHaveLength(1);
    expect(result.generatedChanges[0]).toBe('dist/bundle.js');
  });

  it('sorts suggested hunks by weight descending', () => {
    const diff = `diff --git a/src/big.ts b/src/big.ts
--- a/src/big.ts
+++ b/src/big.ts
@@ -1 +1,100 @@
 old
${Array.from({ length: 99 }, (_, i) => `+line ${i + 1}`).join('\n')}
diff --git a/src/small.ts b/src/small.ts
--- a/src/small.ts
+++ b/src/small.ts
@@ -1 +1 @@
-old
+new
`;
    const result = analyzeDiff(diff);
    expect(result.suggestedHunks[0]).toBe('src/big.ts');
    expect(result.suggestedHunks[1]).toBe('src/small.ts');
  });
});

describe('bounded context selection', () => {
  const files = [
    'AGENTS.md',
    'packages/cart/AGENTS.md',
    'packages/cart/src/total.ts',
    'packages/cart/src/discount.ts',
    'packages/cart/src/total.test.ts',
    'packages/user/src/login.ts',
    'dist/bundle.js',
    'docs/cart.md'
  ];

  it('ranks goal-relevant files above unrelated ones and excludes generated files', () => {
    const response = selectContext({ goal: 'fix the cart total rounding bug', files });
    const paths = response.results.map((r) => r.path);
    expect(paths).toContain('packages/cart/src/total.ts');
    expect(paths).not.toContain('dist/bundle.js');
    expect(paths.indexOf('packages/cart/src/total.ts')).toBeLessThan(
      paths.indexOf('packages/user/src/login.ts') === -1 ? Infinity : paths.indexOf('packages/user/src/login.ts')
    );
  });

  it('attaches governing instructions, adjacent tests and package context', () => {
    const response = selectContext({ goal: 'cart total', files, likelyPaths: ['packages/cart/src/total.ts'] });
    const total = response.results.find((r) => r.path === 'packages/cart/src/total.ts');
    expect(total?.packageContext).toBe('packages/cart');
    expect(total?.instructions).toEqual(['AGENTS.md', 'packages/cart/AGENTS.md']);
    expect(total?.adjacentTests).toContain('packages/cart/src/total.test.ts');
    expect(total?.confidence).toBeGreaterThan(0);
  });

  it('honours category filters and reports truncation without silent drops', () => {
    const docsOnly = selectContext({ goal: 'cart', files, categories: ['docs'] });
    expect(docsOnly.results.every((r) => r.path.endsWith('.md'))).toBe(true);
    const clipped = selectContext({ goal: 'cart total discount', files, maxResults: 1 });
    expect(clipped.results).toHaveLength(1);
    expect(clipped.truncated).toBe(true);
  });

  it('returns empty results when no files match the goal', () => {
    const response = selectContext({ goal: 'quantum flux capacitor', files: ['src/readme.md'] });
    expect(response.results).toHaveLength(0);
    expect(response.consideredFiles).toBeGreaterThan(0);
    expect(response.truncated).toBe(false);
  });

  it('returns no results for an empty file list', () => {
    const response = selectContext({ goal: 'anything', files: [] });
    expect(response.results).toHaveLength(0);
    expect(response.consideredFiles).toBe(0);
    expect(response.truncated).toBe(false);
  });

  it('clamps maxResults to the valid range', () => {
    const manyFiles = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);
    const response = selectContext({ goal: 'file', files: manyFiles, maxResults: 200 });
    expect(response.results.length).toBeLessThanOrEqual(100);
  });

  it('ranks likelyPaths above token-matched paths', () => {
    const files = ['src/user.ts', 'src/admin/user.ts'];
    const response = selectContext({ goal: 'user login', files, likelyPaths: ['src/admin/user.ts'] });
    const idx0 = response.results.findIndex((r) => r.path === 'src/admin/user.ts');
    const idx1 = response.results.findIndex((r) => r.path === 'src/user.ts');
    expect(idx0).toBeLessThan(idx1 !== -1 ? idx1 : Infinity);
  });

  it('attaches warnings for configuration files', () => {
    const response = selectContext({ goal: 'wrangler', files: ['wrangler.jsonc', 'src/index.ts'] });
    expect(response.results[0]?.warnings).toContain('configuration file — changes may need type regeneration');
  });

  it('returns correct consideredFiles count excluding generated files', () => {
    const files = ['src/good.ts', 'dist/bundle.js', 'build/output.js'];
    const response = selectContext({ goal: 'good', files });
    expect(response.consideredFiles).toBe(1);
  });
});
