import { describe, expect, it } from 'vitest';
import { registerLegacyWidgetStub, FORGE_LEGACY_WIDGET_URI } from '../../apps/forge-edge-gateway/src/legacy-widget';

function capture() {
  const registered: { name: string; uri: string; config: Record<string, unknown>; read: () => Promise<{ contents: { text: string }[] }> }[] = [];
  const server = {
    registerResource(name: string, uri: string, config: Record<string, unknown>, read: () => Promise<{ contents: { text: string }[] }>) {
      registered.push({ name, uri, config, read });
    }
  } as never;
  registerLegacyWidgetStub(server);
  return registered;
}

describe('retired Forge Console widget stub', () => {
  it('still answers the URI old sessions ask for', () => {
    // A ChatGPT session opened before the widget was removed keeps requesting
    // this URI on every tool result. When it 404s, the host renders a skeleton
    // card that never resolves — one per tool call, stacked above the answer.
    const [resource] = capture();
    expect(resource?.uri).toBe('ui://forge/workspace-console');
    expect(FORGE_LEGACY_WIDGET_URI).toBe('ui://forge/workspace-console');
  });

  it('renders nothing at all', async () => {
    const [resource] = capture();
    const html = (await resource!.read()).contents[0]!.text;
    // No visible chrome, no reserved height, and nothing that could grow into
    // a component again.
    expect(html).toContain('display:none');
    expect(html).toMatch(/<body>\s*<\/body>/);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html.length).toBeLessThan(400);
  });

  it('makes no network calls, so it cannot hang on a fetch', async () => {
    const [resource] = capture();
    const html = (await resource!.read()).contents[0]!.text;
    expect(html).not.toMatch(/https?:\/\//);
    const meta = resource!.config._meta as { ui?: { csp?: Record<string, string[]> } };
    for (const list of Object.values(meta.ui?.csp ?? {})) expect(list).toEqual([]);
  });
});
