import { describe, expect, it } from 'vitest';
import { selectSecretsForSources, type VaultSecret } from '../../apps/forge-edge-gateway/src/vault';

function secret(id: string, varNames: string[]): VaultSecret {
  return {
    id: id as VaultSecret['id'], tenantId: 'ten_test' as VaultSecret['tenantId'],
    label: id, provider: 'generic', varNames, metadata: {}, state: 'valid',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

describe('direct deploy secret selection', () => {
  it('selects only secrets required by the saved environment mapping', () => {
    const selected = selectSecretsForSources([
      secret('sec_cloudflare', ['CF_TOKEN', 'CF_ACCOUNT']),
      secret('sec_shopify', ['SHOPIFY_TOKEN'])
    ], ['CF_TOKEN', 'CF_ACCOUNT']);
    expect(selected).toMatchObject({ missing: [], ambiguous: [] });
    expect(selected.selected.map((item) => item.id)).toEqual(['sec_cloudflare']);
  });

  it('refuses missing and ambiguous sources instead of guessing', () => {
    const selected = selectSecretsForSources([
      secret('sec_a', ['CF_TOKEN']), secret('sec_b', ['CF_TOKEN'])
    ], ['CF_TOKEN', 'CF_ACCOUNT']);
    expect(selected.missing).toEqual(['CF_ACCOUNT']);
    expect(selected.ambiguous).toEqual(['CF_TOKEN']);
  });
});
