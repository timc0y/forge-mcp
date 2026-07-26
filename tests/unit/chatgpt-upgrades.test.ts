import { describe, expect, it } from 'vitest';
import { createTask, summarizeTask, type TaskHandoff } from '@forge/task-core';
import { ids, type TenantId, type ProjectId } from '@forge/core';

describe('ChatGPT Experience Upgrades', () => {
  it('attaches and summarizes task handoff notes cleanly', () => {
    const task = createTask(ids.task(), '2026-07-26T21:00:00.000Z', {
      tenantId: 'ten_test' as TenantId,
      projectId: 'prj_test' as ProjectId,
      repository: { provider: 'github', owner: 'testowner', name: 'testrepo' },
      baseRef: 'main',
      goal: 'Optimize ChatGPT MCP experience'
    });

    const handoff: TaskHandoff = {
      summary: 'Completed schema and task-core handoff model',
      nextSteps: ['Run unit tests', 'Deploy to Cloudflare'],
      keyLearnings: ['ChatGPT requires non-blocking async operations'],
      modifiedFiles: ['packages/task-core/src/task.ts'],
      createdAt: '2026-07-26T21:30:00.000Z',
      authorAgent: 'chatgpt'
    };

    task.handoff = handoff;
    const summary = summarizeTask(task);

    expect(summary.handoff).toBeDefined();
    expect(summary.handoff?.summary).toBe('Completed schema and task-core handoff model');
    expect(summary.handoff?.nextSteps).toEqual(['Run unit tests', 'Deploy to Cloudflare']);
    expect(summary.handoff?.authorAgent).toBe('chatgpt');
  });
});
