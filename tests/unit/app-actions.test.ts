import { describe, expect, it } from 'vitest';
import {
  classifyActions,
  discoverActions,
  runJourney,
  type ActionCallResult,
  type ActionTransport,
  type StructuredActionManifest
} from '@forge/app-actions';

const MANIFEST: StructuredActionManifest = {
  schemaVersion: 1,
  tools: [
    { name: 'list_products', description: '', inputSchema: {} },
    { name: 'add_to_cart', description: '', inputSchema: {} },
    { name: 'get_cart', description: '', inputSchema: {} },
    { name: 'process_payment', description: '', inputSchema: {} }
  ]
};

function transport(overrides: Partial<Record<string, ActionCallResult>> = {}): ActionTransport {
  const cart: string[] = [];
  return {
    async manifest() {
      return MANIFEST;
    },
    async call(name, input) {
      if (overrides[name]) return overrides[name] as ActionCallResult;
      if (name === 'add_to_cart') {
        cart.push(String(input.productId));
        return { ok: true, summary: 'added', data: { itemCount: cart.length } };
      }
      if (name === 'get_cart') return { ok: true, summary: 'cart', data: { itemCount: cart.length } };
      return { ok: true, summary: name, data: {} };
    }
  };
}

describe('structured action discovery guardrails', () => {
  it('blocks payment-like actions unless explicitly allowed', () => {
    const blocked = classifyActions(MANIFEST);
    expect(blocked.actions.map((a) => a.name)).not.toContain('process_payment');
    expect(blocked.blocked.map((b) => b.name)).toContain('process_payment');

    const allowed = classifyActions(MANIFEST, { allowDangerous: true });
    expect(allowed.actions.map((a) => a.name)).toContain('process_payment');
  });

  it('discovers over a transport', async () => {
    const result = await discoverActions(transport());
    expect(result.actions.length).toBe(3);
  });
});

describe('structured journeys', () => {
  it('passes when every step call and assertion pass', async () => {
    const journey = await runJourney(transport(), [
      { action: 'add_to_cart', input: { productId: 'sku-mug' } },
      { action: 'get_cart', assert: { path: 'itemCount', equals: 1 } }
    ]);
    expect(journey.state).toBe('passed');
    expect(journey.steps[1].assertion?.passed).toBe(true);
  });

  it('fails the journey when an assertion does not hold', async () => {
    const journey = await runJourney(transport(), [
      { action: 'get_cart', assert: { path: 'itemCount', equals: 99 } }
    ]);
    expect(journey.state).toBe('failed');
  });

  it('blocks a step that targets a protected action', async () => {
    const journey = await runJourney(transport(), [{ action: 'process_payment' }]);
    expect(journey.steps[0].state).toBe('blocked');
    expect(journey.state).toBe('blocked');
  });
});
