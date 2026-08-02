import { describe, expect, it, vi } from 'vitest';
import {
  listCloudflareAccounts,
  resolveCloudflareTokenVar
} from '../../apps/forge-edge-gateway/src/cloudflare-accounts';

describe('resolveCloudflareTokenVar', () => {
  it('defaults to CLOUDFLARE_API_TOKEN when present', () => {
    expect(resolveCloudflareTokenVar(['CF_KEY', 'CLOUDFLARE_API_TOKEN'])).toEqual({
      ok: true,
      token_var: 'CLOUDFLARE_API_TOKEN'
    });
  });

  it('uses the sole var when only one exists', () => {
    expect(resolveCloudflareTokenVar(['CF_KEY'])).toEqual({
      ok: true,
      token_var: 'CF_KEY'
    });
  });

  it('honours an explicit token_var', () => {
    expect(resolveCloudflareTokenVar(['CF_KEY', 'OTHER'], 'CF_KEY')).toEqual({
      ok: true,
      token_var: 'CF_KEY'
    });
  });

  it('rejects an unknown token_var', () => {
    const result = resolveCloudflareTokenVar(['CF_KEY'], 'MISSING');
    expect(result.ok).toBe(false);
  });
});

describe('listCloudflareAccounts', () => {
  it('returns id and name only', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: [
            { id: 'acc-1', name: 'Prod' },
            { id: 'acc-2', name: 'Staging', type: 'standard' }
          ]
        }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;
    const result = await listCloudflareAccounts('tok', fetchImpl);
    expect(result).toEqual({
      ok: true,
      accounts: [
        { id: 'acc-1', name: 'Prod' },
        { id: 'acc-2', name: 'Staging' }
      ]
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts?per_page=50',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' })
      })
    );
  });

  it('surfaces API errors without leaking the token', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: 'Invalid token' }] }), {
        status: 401
      })
    ) as unknown as typeof fetch;
    const result = await listCloudflareAccounts('super-secret-token', fetchImpl);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.message).toContain('Invalid token');
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
  });
});
