import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Forge HTML surfaces', () => {
  it('bound public and authenticated layouts to narrow viewports', () => {
    const landing = readFileSync('apps/forge-edge-gateway/src/index.ts', 'utf8');
    const dashboard = readFileSync('apps/forge-edge-gateway/src/github.ts', 'utf8');
    const oauth = readFileSync('apps/forge-edge-gateway/src/oauth.ts', 'utf8');

    expect(landing).toContain('overflow-x:clip');
    expect(landing).toContain("url.pathname === '/favicon.ico'");
    expect(landing).toContain('letter-spacing:-.04em');
    expect(landing).toContain('grid-template-columns:repeat(3,minmax(0,1fr))');
    expect(dashboard).toContain('.layout>*{min-width:0}');
    expect(dashboard).toContain('overflow-wrap:anywhere');
    expect(oauth).toContain('width:min(100% - 2.5rem,32rem)');
  });
});
