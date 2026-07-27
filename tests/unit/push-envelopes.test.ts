import { describe, expect, it } from 'vitest';
import { pathsWithinEnvelope } from '../../apps/forge-edge-gateway/src/push-envelopes';

describe('push envelopes', () => {
  it('returns true for empty changed paths', () => {
    expect(pathsWithinEnvelope([], ['src'])).toBe(true);
  });

  it('validates paths strictly within prefix boundaries', () => {
    expect(pathsWithinEnvelope(['src/index.ts', 'src/utils/math.ts'], ['src'])).toBe(true);
    expect(pathsWithinEnvelope(['src/index.ts'], ['src/'])).toBe(true);
    expect(pathsWithinEnvelope(['src/index.ts'], ['src/index.ts'])).toBe(true);
  });

  it('rejects paths outside allowed prefixes', () => {
    expect(pathsWithinEnvelope(['src-other/index.ts'], ['src'])).toBe(false);
    expect(pathsWithinEnvelope(['package.json'], ['src'])).toBe(false);
    expect(pathsWithinEnvelope(['src/index.ts', 'docs/readme.md'], ['src'])).toBe(false);
  });

  it('supports multiple allowed prefixes', () => {
    expect(pathsWithinEnvelope(['src/index.ts', 'docs/readme.md'], ['src', 'docs'])).toBe(true);
    expect(pathsWithinEnvelope(['src/index.ts', 'other/file.txt'], ['src', 'docs'])).toBe(false);
  });
});
