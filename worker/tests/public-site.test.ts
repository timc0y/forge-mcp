import { describe, expect, it } from 'vitest';
import { documentationManifest } from '../src/documentation';
import { documentationResponse } from '../src/public-site';
import { installedPage, landingPage } from '../src/landing';
import { page } from '../src/ui';
import type { Env } from '../src/env';

const home = 'https://example.com/nested/forge';
const env = { FORGE_PUBLIC_ORIGIN: home, GITHUB_APP_SLUG: 'example-app' } as Env;

describe('public documentation presentation', () => {
  it.each(documentationManifest.map(entry => [entry.slug]))('serves %s without duplicating its source H1', async slug => {
    const response = documentationResponse(home, slug);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Documentation"');
    expect(html).toContain('aria-label="Documentation on mobile"');
    expect(html).toContain('aria-label="Sections on this page"');
    expect(html).toContain(`${home}/docs`);
    expect(html).toContain(`${home}/fonts/onest-variable.ttf`);
    expect(response.headers.get('cache-control')).toBe('public,max-age=300');
  });

  it('returns a noindex recoverable 404 for unknown slugs', async () => {
    const response = documentationResponse(home, 'missing');
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('noindex,nofollow');
    expect(html).toContain(`href="${home}/docs"`);
  });

  it('keeps private operational pages unindexed and uncached', async () => {
    const response = page({ title: 'Approval', body: '<h1>Review</h1>', home });
    const html = await response.text();
    expect(html).not.toContain('class="public-site"');
    expect(html).not.toContain('/fonts/');
    expect(html).toContain('noindex,nofollow');
    expect(response.headers.get('cache-control')).toBe('private,no-store');
    expect(response.headers.get('content-security-policy')).not.toContain('script-src');
  });

  it('preserves the installation handoff and leads public visitors to self-hosting and source', async () => {
    const installed = await installedPage(env, 'update').text();
    expect(installed).toContain('Verify your connection');
    expect(installed).toContain('cannot confirm installation or repository access');
    expect(installed).not.toContain('Forge can now reach');
    expect(installed).not.toContain(`${home}/mcp`);
    const html = await landingPage(env).text();
    expect(html).toContain(`href="${home}/docs/self-hosting">Run your own Forge`);
    expect(html).toContain(`href="${home}/docs/self-hosting">Self-host Forge`);
    expect(html).toContain('href="https://github.com/timc0y/forge-mcp">Source on GitHub');
    expect(html).toContain('MIT-licensed source');
    expect(html).toContain('The guide takes you from setup to your first commit');
    expect(html).toContain('Illustrative example');
    expect(html).not.toMatch(/free|hosted preview|waitlist|marketplace/i);
  });

  it('does not advertise the operator connection on public pages', async () => {
    const html = await landingPage(env).text();
    expect(html).not.toContain(`${home}/mcp`);
    expect(html).not.toContain('private-connection');
    expect(html).not.toContain('https://github.com/apps/example-app');
    expect(html).toContain('by <a href="https://timcoy.uk/">Tim Coy</a>');
    expect(html).not.toContain('Operator contact');
  });
});
