import { describe, expect, it } from 'vitest';
import { isTextualArtifact } from '../../apps/forge-edge-gateway/src/artifact-content';

describe('artifact read-back', () => {
  it('treats a recovery patch as text', () => {
    // forge_work_export stores recovery patches with exactly this content type.
    // Until this returned true, forge_artifact_get replied with metadata only —
    // size_bytes and content_type but no bytes — so the artifact that exists to
    // rescue unpushed work could be written and described but never read back.
    expect(isTextualArtifact('text/plain; charset=utf-8')).toBe(true);
  });

  it('covers the other text-shaped types', () => {
    for (const mime of ['text/markdown', 'application/json', 'application/xml', 'application/x-patch', 'application/vnd.api+json']) {
      expect(isTextualArtifact(mime), mime).toBe(true);
    }
  });

  it('leaves genuinely binary types to base64', () => {
    for (const mime of ['image/png', 'application/octet-stream', 'application/zip', 'video/mp4']) {
      expect(isTextualArtifact(mime), mime).toBe(false);
    }
  });
});
