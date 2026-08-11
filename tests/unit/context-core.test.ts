import { describe, expect, it } from 'vitest';
import { createForgeContextPack, forgeContextWorkspace } from '@forge/insight';

const scope = {
  workspaceId: 'workspace-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  repository: { provider: 'github', owner: 'timc0y', name: 'forge-mcp' },
};

describe('Forge Context Core adapter', () => {
  it('keeps the context boundary at tenant/project while the subject is an ephemeral workspace', () => {
    expect(forgeContextWorkspace(scope)).toEqual({
      productId: 'forge',
      id: 'tenant-1:project-1',
      label: 'timc0y/forge-mcp',
    });
  });

  it('creates a source-backed repository review pack without repository file contents', () => {
    const pack = createForgeContextPack({
      scope,
      subject: { kind: 'review.repository', id: 'review-1', label: 'Pre-merge review' },
      createdAt: '2026-08-11T10:10:00.000Z',
      sources: [
        {
          id: 'diff-1',
          kind: 'repository.diff',
          label: 'Pull request diff',
          locator: { type: 'opaque', value: 'pr-12' },
          capturedAt: '2026-08-11T10:09:00.000Z',
          classification: 'private',
        },
      ],
      observations: [
        {
          id: 'obs-1',
          kind: 'observation.review.check',
          statement: 'The focused test suite passed.',
          evidence: [{ sourceId: 'diff-1', locator: { type: 'whole_source' } }],
          provenance: { kind: 'plugin', id: 'forge-review', version: '1.0.0' },
          status: 'observed',
          createdAt: '2026-08-11T10:10:00.000Z',
        },
      ],
    });

    expect(pack.observations[0]?.evidence[0]?.sourceId).toBe('diff-1');
    expect(pack.training).toEqual({ disposition: 'excluded' });
  });
});
