import { describe, expect, it } from 'vitest';
import { ForgeError, ids, type ProjectId, type TenantId } from '@forge/core';
import {
  InMemoryTaskStore,
  applyTaskPatch,
  assertTaskOwnership,
  assertTaskTransition,
  createTask,
  isTerminalTaskState,
  redactSecrets,
  summarizeTask,
  type RepositoryRef,
  type TaskStartInput
} from '@forge/task-core';

const AT = '2026-07-16T00:00:00.000Z';
const LATER = '2026-07-16T01:00:00.000Z';
const repository: RepositoryRef = { provider: 'github', owner: 'timcoy47', name: 'forge-mcp' };

function newInput(overrides: Partial<TaskStartInput> = {}): TaskStartInput {
  return {
    tenantId: ids.tenant(),
    projectId: ids.project(),
    repository,
    baseRef: 'main',
    goal: 'Fix the cart total rounding bug',
    ...overrides
  };
}

describe('durable task lifecycle', () => {
  it('creates a planning task with sane defaults and revision 1', () => {
    const task = createTask(ids.task(), AT, newInput());
    expect(task.state).toBe('planning');
    expect(task.revision).toBe(1);
    expect(task.changedFiles).toEqual([]);
    expect(task.createdAt).toBe(AT);
  });

  it('validates allowed transitions and rejects illegal ones', () => {
    expect(() => assertTaskTransition('planning', 'coding')).not.toThrow();
    expect(() => assertTaskTransition('coding', 'reviewing')).not.toThrow();
    expect(() => assertTaskTransition('complete', 'coding')).toThrow(ForgeError);
    expect(() => assertTaskTransition('planning', 'complete')).toThrow(ForgeError);
  });

  it('treats terminal states as absorbing', () => {
    expect(isTerminalTaskState('complete')).toBe(true);
    expect(isTerminalTaskState('cancelled')).toBe(true);
    expect(isTerminalTaskState('coding')).toBe(false);
  });

  it('bumps revision and merges additive fields without duplication', () => {
    let task = createTask(ids.task(), AT, newInput());
    const proc = ids.process();
    task = applyTaskPatch(task, { state: 'coding', addChangedFiles: ['src/cart.ts'], addProcessIds: [proc] }, LATER);
    task = applyTaskPatch(task, { addChangedFiles: ['src/cart.ts', 'src/total.ts'], addProcessIds: [proc] }, LATER);
    expect(task.revision).toBe(3);
    expect(task.changedFiles).toEqual(['src/cart.ts', 'src/total.ts']);
    expect(task.processIds).toEqual([proc]);
    expect(task.state).toBe('coding');
  });

  it('enforces optimistic revision on patch', () => {
    const task = createTask(ids.task(), AT, newInput());
    expect(() => applyTaskPatch(task, { state: 'ready' }, LATER, 999)).toThrowError(
      expect.objectContaining({ code: 'FORGE_STALE_REVISION' })
    );
  });
});

describe('workspace ownership', () => {
  it('rejects tasks belonging to another tenant', () => {
    const task = createTask(ids.task(), AT, newInput());
    expect(() => assertTaskOwnership(task, { tenantId: task.tenantId })).not.toThrow();
    expect(() => assertTaskOwnership(task, { tenantId: ids.tenant() })).toThrowError(
      expect.objectContaining({ code: 'FORGE_PERMISSION_DENIED' })
    );
  });
});

describe('durable store survives reconnect', () => {
  it('round-trips a task through put/get after mutation', async () => {
    const store = new InMemoryTaskStore();
    let task = createTask(ids.task(), AT, newInput());
    await store.put(task);
    task = applyTaskPatch(task, { state: 'coding', branch: 'forge/cart-fix', addChangedFiles: ['src/cart.ts'] }, LATER);
    await store.put(task);

    // Simulate a fresh turn / reconnect: only the task id survives in context.
    const resumed = await store.get(task.id);
    expect(resumed).not.toBeNull();
    expect(resumed?.state).toBe('coding');
    expect(resumed?.branch).toBe('forge/cart-fix');
    expect(resumed?.changedFiles).toEqual(['src/cart.ts']);
    expect(resumed?.revision).toBe(2);
  });

  it('lists a tenant\'s tasks most-recent first and filters by state and tenant', async () => {
    const store = new InMemoryTaskStore();
    const tenantId = ids.tenant() as TenantId;
    const projectId = ids.project() as ProjectId;
    const older = createTask(ids.task(), AT, newInput({ tenantId, projectId }));
    const newer = applyTaskPatch(
      createTask(ids.task(), AT, newInput({ tenantId, projectId })),
      { state: 'coding' },
      LATER
    );
    const otherTenant = createTask(ids.task(), LATER, newInput());
    await store.put(older);
    await store.put(newer);
    await store.put(otherTenant);

    const all = await store.list(tenantId);
    expect(all.map((t) => t.id)).toEqual([newer.id, older.id]);
    const coding = await store.list(tenantId, { state: 'coding' });
    expect(coding.map((t) => t.id)).toEqual([newer.id]);
  });

  it('stored copies are isolated from later in-memory mutation', async () => {
    const store = new InMemoryTaskStore();
    const task = createTask(ids.task(), AT, newInput());
    await store.put(task);
    task.goal = 'mutated after storing';
    const fetched = await store.get(task.id);
    expect(fetched?.goal).toBe('Fix the cart total rounding bug');
  });
});

describe('compact task summary', () => {
  it('includes resume-critical context and a deterministic next action', () => {
    let task = createTask(ids.task(), AT, newInput({ decisions: ['round with banker rounding'] }));
    task = applyTaskPatch(
      task,
      {
        state: 'coding',
        branch: 'forge/cart-fix',
        workspaceId: ids.workspace(),
        addChangedFiles: ['src/cart.ts'],
        addChecks: [{ command: 'pnpm -F cart test', cwd: '/workspace/repo', status: 'passed', ranAt: LATER }]
      },
      LATER
    );
    const summary = summarizeTask(task);
    expect(summary.goal).toContain('rounding bug');
    expect(summary.decisions).toEqual(['round with banker rounding']);
    expect(summary.branch).toBe('forge/cart-fix');
    expect(summary.workspaceState).toBe('attached');
    expect(summary.filesChanged).toEqual(['src/cart.ts']);
    expect(summary.checks).toEqual([{ command: 'pnpm -F cart test', status: 'passed' }]);
    expect(summary.nextRecommendedAction).toMatch(/narrow|targeted/i);
  });

  it('flags reviewing without an inspected diff as unsafe to push', () => {
    let task = createTask(ids.task(), AT, newInput());
    task = applyTaskPatch(task, { state: 'coding', addChangedFiles: ['src/cart.ts'] }, LATER);
    task = applyTaskPatch(task, { state: 'reviewing' }, LATER);
    const summary = summarizeTask(task);
    expect(summary.knownLimitations.join(' ')).toMatch(/diff not yet inspected/i);
  });

  it('never leaks secrets into the summary', () => {
    const leaked = 'use token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 to auth';
    let task = createTask(ids.task(), AT, newInput({ goal: leaked }));
    task = applyTaskPatch(task, { outstanding: [leaked] }, LATER);
    const summary = summarizeTask(task);
    expect(JSON.stringify(summary)).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(summary.goal).toContain('[redacted]');
  });
});

describe('secret redaction', () => {
  it('redacts common credential shapes and leaves ordinary text intact', () => {
    expect(redactSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toBe('[redacted]');
    expect(redactSecrets('https://user:supersecret@example.com')).toContain('[redacted]');
    expect(redactSecrets('a normal sentence about carts')).toBe('a normal sentence about carts');
  });
});
