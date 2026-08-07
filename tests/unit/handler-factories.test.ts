import { describe, expect, it } from 'vitest';
import type { LegacyForgeToolHandlers } from '@forge/mcp-core';
import type { Env } from '../../apps/forge-edge-gateway/src/env';
import type { SessionHandlerDependencies } from '../../apps/forge-edge-gateway/src/handlers/types';
import { taskToolHandlers } from '../../apps/forge-edge-gateway/src/handlers/tasks';
import { reviewArtifactToolHandlers } from '../../apps/forge-edge-gateway/src/handlers/review-artifacts';
import { repositoryWorkspaceToolHandlers } from '../../apps/forge-edge-gateway/src/handlers/repository-workspace';
import { executionToolHandlers } from '../../apps/forge-edge-gateway/src/handlers/execution';
import { systemToolHandlers } from '../../apps/forge-edge-gateway/src/handlers/system';

describe('focused legacy handler factories', () => {
  it('compose into one disjoint handler interface', () => {
    const env = {} as Env;
    const deps = {} as SessionHandlerDependencies;
    const groups = [
      systemToolHandlers(env, () => ({ subject: 'test', tenantId: 'tenant', projectId: 'project' })),
      taskToolHandlers(env, deps),
      reviewArtifactToolHandlers(env, deps),
      repositoryWorkspaceToolHandlers(env, deps),
      executionToolHandlers(env, deps)
    ];
    const names = groups.flatMap((group) => Object.keys(group));
    const handlers = Object.assign({}, ...groups) as LegacyForgeToolHandlers;

    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(handlers)).toHaveLength(47);
    expect(handlers.forge_edit).toBeTypeOf('function');
    expect(handlers.forge_shell).toBeTypeOf('function');
    expect(handlers.forge_deploy).toBeTypeOf('function');
    expect(handlers.forge_secret_accounts).toBeTypeOf('function');
    expect(handlers.forge_task_update).toBeTypeOf('function');
  });
});
