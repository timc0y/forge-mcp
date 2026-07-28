import { describe, expect, it } from 'vitest';
import { ids } from '@forge/core';
import {
  InMemoryTaskStore,
  applyTaskPatch,
  createTask,
  summarizeTask
} from '@forge/task-core';
import { analyzeDiff, selectContext, suggestChecks } from '@forge/insight';
import { closeBrowserSession, openBrowserSession, recordCapture } from '@forge/browser-core';

/**
 * The reference acceptance flow, exercised at the repository-local logic level
 * against the checked-in fixture. Cloudflare runtime steps (real sandbox,
 * preview routing, Browser Rendering) are proven separately by cloud
 * acceptance; here every deterministic core is composed and asserted.
 */

const AT = '2026-07-16T00:00:00.000Z';

describe('reference acceptance flow (repository-local)', () => {
  it('runs task → context → patch metadata → checks → browser capture → summary', async () => {
    // 1-3. Start a durable task; one workspace would attach here.
    const store = new InMemoryTaskStore();
    let task = createTask(ids.task(), AT, {
      tenantId: ids.tenant(),
      projectId: ids.project(),
      repository: { provider: 'github', owner: 'timcoy47', name: 'forge-mcp' },
      baseRef: 'main',
      goal: 'fix the cart total delivery rounding in the fixture catalogue',
      likelyPaths: ['apps/fixture-catalog/src/catalog.ts']
    });
    task = applyTaskPatch(task, { state: 'coding', workspaceId: ids.workspace() }, AT);
    await store.put(task);

    // 4. Bounded context selection points at the catalogue.
    const context = selectContext({
      goal: task.goal,
      files: [
        'apps/fixture-catalog/src/catalog.ts',
        'apps/fixture-catalog/src/server.ts',
        'apps/fixture-catalog/src/actions.ts',
        'tests/unit/fixture-catalog.test.ts',
        'docs/README.md'
      ],
      likelyPaths: task.likelyPaths
    });
    expect(context.results[0].path).toBe('apps/fixture-catalog/src/catalog.ts');

    // 6-7. Apply a coherent patch (represented by its diff) and derive checks.
    const diff = `diff --git a/apps/fixture-catalog/src/catalog.ts b/apps/fixture-catalog/src/catalog.ts
--- a/apps/fixture-catalog/src/catalog.ts
+++ b/apps/fixture-catalog/src/catalog.ts
@@ -1,3 +1,4 @@
-export function computeTotals(lines) {
+export function computeTotals(lines, freeThreshold) {
+  const threshold = freeThreshold;
   return lines;
 }
`;
    const compact = analyzeDiff(diff);
    expect(compact.changedExports).toContain('computeTotals');
    const checks = suggestChecks(compact.files.map((f) => f.path));
    expect(checks[0].command).toContain('apps/fixture-catalog');
    task = applyTaskPatch(task, {
      state: 'validating',
      addChangedFiles: compact.files.map((f) => f.path),
      addChecks: [{ command: checks[0].command, cwd: checks[0].cwd, status: 'passed', ranAt: AT }],
      latestDiffHash: compact.hash
    }, AT);

    // 11-12. Browser session capturing phone and desktop evidence.
    let bs = openBrowserSession({ id: 'bs_1', workspaceId: task.workspaceId!, previewId: 'prv_1', at: AT });
    bs = recordCapture(bs, 'art_phone', AT);
    bs = recordCapture(bs, 'art_desktop', AT);
    bs = closeBrowserSession(bs, '2026-07-16T00:00:03.000Z');
    expect(bs.captureIds).toHaveLength(2);

    task = applyTaskPatch(task, {
      state: 'reviewing',
      addEvidenceIds: [ids.artifact(), ids.artifact()]
    }, AT);
    await store.put(task);

    // 13. Compact task summary is enough to resume without replay.
    const summary = summarizeTask(await store.get(task.id) as NonNullable<Awaited<ReturnType<typeof store.get>>>);
    expect(summary.filesChanged).toContain('apps/fixture-catalog/src/catalog.ts');
    expect(summary.evidence).toHaveLength(2);
    expect(summary.checks[0].status).toBe('passed');

    // 20. Task and evidence records remain retrievable after completion.
    task = applyTaskPatch(task, { state: 'complete' }, AT);
    await store.put(task);
    const finished = await store.get(task.id);
    expect(finished?.state).toBe('complete');
    expect(finished?.evidenceIds).toHaveLength(2);
  });
});
