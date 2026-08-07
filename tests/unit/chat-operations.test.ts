import { beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ state: 'provisioning' }));

vi.mock('../../apps/forge-edge-gateway/src/workspace-operations', () => ({
  workspaceOperations: () => ({
    getAuthorizationBinding: async () => ({ state: workspaceState.state }),
    requestDestroy: async () => ({ state: 'destroyed' })
  })
}));

import {
  ChatOperationStore,
  issueChatOperationStatusUrl,
  matchesChatOperationReference,
  reconcileChatOperation,
  verifyChatOperationStatusToken
} from '../../apps/forge-edge-gateway/src/chat-operations';

interface Row extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  project_id: string;
  repository: string | null;
  repository_ref: string | null;
  kind: string;
  state: string;
  summary: string;
  result_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function memoryDb(): D1Database {
  const rows = new Map<string, Row>();
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          values = args;
          return statement;
        },
        async run() {
          if (/INSERT INTO chat_operations/u.test(sql)) {
            const [id, tenant, project, repository, repositoryRef, kind, state, summary, result, error, created, updated, completed] = values;
            rows.set(String(id), {
              id: String(id), tenant_id: String(tenant), project_id: String(project), repository: repository as string | null,
              repository_ref: repositoryRef as string | null, kind: String(kind), state: String(state),
              summary: String(summary), result_json: result as string | null, error_message: error as string | null,
              created_at: String(created), updated_at: String(updated), completed_at: completed as string | null
            });
          } else if (/UPDATE chat_operations/u.test(sql)) {
            const [state, summary, result, error, updated, completed, tenant, id] = values;
            const row = rows.get(String(id));
            if (row && row.tenant_id === tenant) Object.assign(row, {
              state, summary, result_json: result, error_message: error, updated_at: updated, completed_at: completed
            });
          }
          return { success: true, meta: { changes: 1 } };
        },
        async first<T>() {
          if (/WHERE tenant_id = \? AND project_id = \? AND id = \?/u.test(sql)) {
            const [tenant, project, id] = values;
            const row = rows.get(String(id));
            return (row?.tenant_id === tenant && row.project_id === project ? row : null) as T | null;
          }
          if (/WHERE tenant_id = \? AND id = \?/u.test(sql)) {
            const [tenant, id] = values;
            const row = rows.get(String(id));
            return (row?.tenant_id === tenant ? row : null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          const [tenant, project, repository] = values;
          return {
            results: [...rows.values()]
              .filter((row) => row.tenant_id === tenant && row.project_id === project && (!repository || row.repository === repository))
              .sort((a, b) => b.updated_at.localeCompare(a.updated_at)) as T[]
          };
        }
      };
      return statement;
    }
  } as unknown as D1Database;
}

describe('chat operation registry', () => {
  beforeEach(() => {
    workspaceState.state = 'provisioning';
  });

  it('persists a terminal receipt and supports semantic repository recovery', async () => {
    const store = new ChatOperationStore(memoryDb());
    await store.create({
      id: 'op_123', tenantId: 'ten_a', projectId: 'prj_a', repository: 'acme/site', repositoryRef: 'acme/site#forge/nav',
      kind: 'run', state: 'running', summary: 'Tests are running.'
    });
    await store.complete('ten_a', 'op_123', {
      state: 'completed', summary: 'Tests passed.', result: { exit_code: 0 }
    });

    await expect(store.get('ten_a', 'op_123')).resolves.toMatchObject({
      state: 'completed', summary: 'Tests passed.', result: { exit_code: 0 }
    });
    await expect(store.listRecent('ten_a', 'prj_a', 'acme/site')).resolves.toEqual([
      expect.objectContaining({ id: 'op_123', repository_ref: 'acme/site#forge/nav' })
    ]);
    await expect(store.get('ten_b', 'op_123')).resolves.toBeNull();
  });

  it('moves a deferred operation from approval into background execution', async () => {
    const store = new ChatOperationStore(memoryDb());
    await store.create({
      id: 'op_deploy', tenantId: 'ten_a', projectId: 'prj_a', repository: 'acme/site', repositoryRef: 'acme/site#forge/release',
      kind: 'deploy', state: 'approval_required', summary: 'Waiting for approval.'
    });
    await store.update('ten_a', 'op_deploy', {
      state: 'running', summary: 'Deployment is running.', result: { process_id: 'proc_private' }
    });

    await expect(store.get('ten_a', 'op_deploy')).resolves.toMatchObject({
      state: 'running', summary: 'Deployment is running.', result: { process_id: 'proc_private' }
    });
  });

  it('reconciles private executor startup to a public retry-ready state', async () => {
    const db = memoryDb();
    const store = new ChatOperationStore(db);
    await store.create({
      id: 'op_start',
      tenantId: 'ten_a',
      projectId: 'prj_a',
      repository: 'acme/site',
      repositoryRef: 'acme/site#forge/start',
      kind: 'run',
      state: 'running',
      summary: 'Forge is starting the private executor; no command has run yet.',
      result: { workspace_id: 'ws_private', executor_starting: true }
    });
    const pending = await store.get('ten_a', 'op_start');
    expect(pending).not.toBeNull();

    const stillStarting = await reconcileChatOperation({ METADATA: db } as never, 'ten_a', pending!);
    expect(stillStarting).toMatchObject({
      state: 'running',
      summary: 'Private executor is provisioning; no command has run yet.',
      result: { workspace_id: 'ws_private', executor_starting: true, executor_state: 'provisioning' }
    });

    workspaceState.state = 'ready';
    const ready = await reconcileChatOperation({ METADATA: db } as never, 'ten_a', stillStarting);
    expect(ready).toMatchObject({
      state: 'running',
      summary: 'Private executor is ready. Retry forge_run with the same repository and branch; no command has run yet.',
      result: { workspace_id: 'ws_private', executor_starting: false, executor_ready: true, executor_state: 'ready' }
    });

    workspaceState.state = 'destroyed';
    const failed = await reconcileChatOperation({ METADATA: db } as never, 'ten_a', stillStarting);
    expect(failed).toMatchObject({
      state: 'failed',
      result: { executor_starting: false, executor_ready: false, executor_failed: true, executor_state: 'destroyed' }
    });
  });

  it('does not recover a different branch through repository-wide status lookup', () => {
    const operation = {
      repository_ref: 'acme/site#forge/a',
      result: { requested_ref: 'main' }
    } as never;

    expect(matchesChatOperationReference(operation, 'acme/site#forge/a', 'forge/a')).toBe(true);
    expect(matchesChatOperationReference(operation, 'acme/site#forge/b', 'forge/b')).toBe(false);
    expect(matchesChatOperationReference(operation, 'acme/site#forge/a', 'main')).toBe(true);
  });

  it('issues an expiring tenant-and-operation-bound status URL', async () => {
    const env = {
      FORGE_PUBLIC_ORIGIN: 'https://forge.example',
      FORGE_CAPABILITY_SIGNING_KEY: 'x'.repeat(48)
    } as never;
    const url = await issueChatOperationStatusUrl(env, 'ten_a', 'op_123');
    const parsed = new URL(url);
    const claims = await verifyChatOperationStatusToken(env, parsed.searchParams.get('t') ?? '');

    expect(parsed.pathname).toBe('/status/op_123');
    expect(claims).toMatchObject({ tenant: 'ten_a', operation: 'op_123' });
    await expect(verifyChatOperationStatusToken(env, `${parsed.searchParams.get('t')}tampered`)).resolves.toBeNull();
  });
});
