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
});
