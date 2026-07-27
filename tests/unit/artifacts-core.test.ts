import { describe, expect, it } from 'vitest';
import type { ArtifactWriteInput, ArtifactRef, ArtifactStore } from '@forge/artifacts-core';
import type { ArtifactId, TenantId, WorkspaceId } from '@forge/core';

describe('artifacts-core package interface contracts', () => {
  it('defines valid artifact write input and ref shapes', () => {
    const input: ArtifactWriteInput = {
      id: 'art_1234567890123456789012' as ArtifactId,
      tenantId: 'ten_123' as TenantId,
      workspaceId: 'wsp_123' as WorkspaceId,
      kind: 'screenshot',
      contentType: 'image/png',
      bytes: new ArrayBuffer(8),
      metadata: { key: 'val' }
    };

    const ref: ArtifactRef = {
      id: input.id,
      key: 'ten_123/wsp_123/art_1234567890123456789012',
      contentType: input.contentType,
      sizeBytes: 8,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    };

    expect(ref.key).toContain(input.id);
    expect(ref.sizeBytes).toBe(8);
  });
});
