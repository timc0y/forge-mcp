import { describe, expect, it } from 'vitest';
import { workflowInstanceId, workflowRetryPolicy } from '@forge/workflows-cloudflare';
import type { WorkspaceId } from '@forge/core';

describe('workflows-cloudflare package', () => {
  it('generates expected workflow instance IDs', () => {
    const wsId = 'ws_1234567890123456789012' as WorkspaceId;
    expect(workflowInstanceId('provision', wsId)).toBe(`provision-${wsId}`);
    expect(workflowInstanceId('suspend', wsId)).toBe(`suspend-${wsId}`);
    expect(workflowInstanceId('restore', wsId)).toBe(`restore-${wsId}`);
    expect(workflowInstanceId('destroy', wsId)).toBe(`destroy-${wsId}`);
    expect(workflowInstanceId('pull-request', wsId)).toBe(`pull-request-${wsId}`);
  });

  it('exports retry policy configuration', () => {
    expect(workflowRetryPolicy.retries.limit).toBe(3);
    expect(workflowRetryPolicy.retries.delay).toBe('5 seconds');
    expect(workflowRetryPolicy.retries.backoff).toBe('exponential');
    expect(workflowRetryPolicy.timeout).toBe('15 minutes');
  });
});
