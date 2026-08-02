import { describe, expect, it } from 'vitest';
import { redactPayload, serialiseBounded } from '../../apps/forge-edge-gateway/src/tool-call-log';

describe('tool call payload capture', () => {
  it('never writes a secret-shaped value', () => {
    // Redaction is by key name: a token is indistinguishable from any other
    // string, and guessing wrong writes a live credential into D1.
    const out = redactPayload({
      command: 'echo hi',
      environment: { GITHUB_TOKEN: 'ghp_real', API_KEY: 'sk-real', SAFE: 'keep' },
      content_base64: 'AAAA',
      authorization: 'Bearer real'
    }) as Record<string, Record<string, string>>;

    expect(out.environment.GITHUB_TOKEN).toBe('[redacted]');
    expect(out.environment.API_KEY).toBe('[redacted]');
    expect(out.environment.SAFE).toBe('keep');
    expect(out.content_base64).toBe('[redacted]');
    expect(out.authorization).toBe('[redacted]');
    expect(JSON.stringify(out)).not.toContain('ghp_real');
    expect(JSON.stringify(out)).not.toContain('sk-real');
  });

  it('previews long values but reports their real size', () => {
    const out = redactPayload({ content: 'x'.repeat(5000) }) as { content: string };
    expect(out.content.length).toBeLessThan(700);
    expect(out.content).toContain('5000 chars total');
  });

  it('bounds a whole payload and says the true byte count', () => {
    const files = Array.from({ length: 50 }, (_, i) => ({ path: `src/${i}.ts`, content: 'y'.repeat(2000) }));
    const { json, bytes } = serialiseBounded({ files });
    expect(json.length).toBeLessThanOrEqual(8_020);
    expect(bytes).toBeGreaterThan(json.length - 20);
  });

  it('survives values that cannot be serialised', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => serialiseBounded(cyclic)).not.toThrow();
  });
});

import { repeatCallGuidance } from '../../apps/forge-edge-gateway/src/tool-call-log';

describe('repeat-call steer', () => {
  it('tells the agent the arguments are the problem, not a transient fault', () => {
    // A strict host retries identical calls. The error is correct every time
    // and says nothing about the repetition, so nothing signals that trying
    // again is futile — which is how one bad call becomes sixteen.
    const steer = repeatCallGuidance('forge_edit', 3);
    expect(steer).toContain('3 times');
    expect(steer).toMatch(/arguments are the problem/u);
    expect(steer).toMatch(/Do not repeat this call/u);
    // It must name concrete alternatives, not just forbid the retry.
    expect(steer).toMatch(/different arguments|different tool|read the file first/u);
  });
});

describe('priorIdenticalSuccesses query shape', () => {
  it('is exported beside priorIdenticalFailures for observer stop-polling', async () => {
    const mod = await import('../../apps/forge-edge-gateway/src/tool-call-log');
    expect(typeof mod.priorIdenticalSuccesses).toBe('function');
    expect(typeof mod.priorIdenticalFailures).toBe('function');
  });
});
