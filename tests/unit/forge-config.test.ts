import { describe, expect, it } from 'vitest';
import { normalizePreviewCwd, parseForgeConfig } from '@forge/project-detection';

describe('repository Forge preview config', () => {
  it('normalizes safe repository-relative paths', () => {
    expect(normalizePreviewCwd('./apps//web/')).toBe('apps/web');
    expect(normalizePreviewCwd('.')).toBe('.');
    expect(normalizePreviewCwd('../outside')).toBeNull();
    expect(normalizePreviewCwd('/workspace/repo')).toBeNull();
    expect(normalizePreviewCwd('apps/\nweb')).toBeNull();
  });

  it('accepts only the small preview launch contract', () => {
    expect(parseForgeConfig({
      preview: { cwd: 'apps/web', command: 'pnpm dev --host 0.0.0.0', port: 4173 }
    })).toEqual({
      preview: { cwd: 'apps/web', command: 'pnpm dev --host 0.0.0.0', port: 4173 }
    });
  });

  it('rejects unsafe paths, ports, and control characters', () => {
    expect(parseForgeConfig({ preview: { cwd: '../outside' } }).error).toMatch(/inside the repository/u);
    expect(parseForgeConfig({ preview: { port: 80 } }).error).toMatch(/1024 to 65535/u);
    expect(parseForgeConfig({ preview: { command: 'vite\nrm -rf .' } }).error).toMatch(/control characters/u);
  });

  it('allows config files to provide only a cwd or port and keeps secrets out of the shape', () => {
    const result = parseForgeConfig({ preview: { cwd: 'apps/web', port: 3000, env: { TOKEN: 'secret' } } });
    expect(result).toEqual({ preview: { cwd: 'apps/web', port: 3000 } });
    expect(JSON.stringify(result)).not.toContain('TOKEN');
  });
});
