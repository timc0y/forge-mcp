import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Forge HTML surfaces', () => {
  it('bound public and authenticated layouts to narrow viewports', () => {
    const landing = readFileSync('apps/forge-edge-gateway/src/index.ts', 'utf8');
    const dashboard = readFileSync('apps/forge-edge-gateway/src/github.ts', 'utf8');
    const oauth = readFileSync('apps/forge-edge-gateway/src/oauth.ts', 'utf8');

    expect(landing).toContain('overflow-x:clip');
    expect(landing).toContain("url.pathname === '/favicon.ico'");
    // Assert the properties that keep the page usable on a phone, not the exact
    // declarations of one particular design — a redesign should be free to
    // change type and colour without tripping a layout guard.
    expect(landing).toContain('width:min(100% - 2.5rem,64rem)');
    // Cards reflow rather than being pinned to a fixed column count.
    expect(landing).toMatch(/grid-template-columns:repeat\(auto-fit,minmax\(min\(100%/);
    // Actions stack instead of overflowing on a narrow screen.
    expect(landing).toMatch(/@media\(max-width:640px\)\{[^}]*flex-direction:column/);
    expect(dashboard).toContain('.layout>*{min-width:0}');
    expect(dashboard).toContain('overflow-wrap:anywhere');
    expect(oauth).toContain('width:min(100% - 2.5rem,32rem)');
  });
});
