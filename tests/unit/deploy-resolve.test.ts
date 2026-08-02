import { describe, expect, it } from 'vitest';
import {
  DEPLOY_WORKFLOWS,
  deployCapabilitiesManifest,
  resolveCloudflareDeploy,
  resolveDeployWorkflow
} from '@forge/application';

describe('env-driven deploy resolution', () => {
  it('matches canonical Cloudflare env names', () => {
    const resolved = resolveCloudflareDeploy({
      CLOUDFLARE_API_TOKEN: ' tok ',
      CLOUDFLARE_ACCOUNT_ID: 'acct'
    });
    expect(resolved).toMatchObject({
      workflow: 'cloudflare_wrangler',
      apiToken: 'tok',
      accountId: 'acct',
      matched: {
        api_token: 'CLOUDFLARE_API_TOKEN',
        account_id: 'CLOUDFLARE_ACCOUNT_ID'
      }
    });
    expect(resolved?.processEnv.CLOUDFLARE_API_TOKEN).toBe('tok');
    expect(resolved?.processEnv.CLOUDFLARE_ACCOUNT_ID).toBe('acct');
  });

  it('accepts CF_* aliases and normalizes them for Wrangler', () => {
    const resolved = resolveDeployWorkflow({
      CF_API_TOKEN: 'alias-token',
      CF_ACCOUNT_ID: 'alias-acct',
      OTHER_KEY: 'keep-me'
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.resolution.matched).toEqual({
      api_token: 'CF_API_TOKEN',
      account_id: 'CF_ACCOUNT_ID'
    });
    expect(resolved.resolution.processEnv).toMatchObject({
      CF_API_TOKEN: 'alias-token',
      CF_ACCOUNT_ID: 'alias-acct',
      OTHER_KEY: 'keep-me',
      CLOUDFLARE_API_TOKEN: 'alias-token',
      CLOUDFLARE_ACCOUNT_ID: 'alias-acct'
    });
  });

  it('prefers canonical names when both canonical and alias are present', () => {
    const resolved = resolveCloudflareDeploy({
      CLOUDFLARE_API_TOKEN: 'canonical',
      CF_API_TOKEN: 'alias',
      CLOUDFLARE_ACCOUNT_ID: 'acct-canonical',
      CF_ACCOUNT_ID: 'acct-alias'
    });
    expect(resolved?.matched).toEqual({
      api_token: 'CLOUDFLARE_API_TOKEN',
      account_id: 'CLOUDFLARE_ACCOUNT_ID'
    });
    expect(resolved?.apiToken).toBe('canonical');
  });

  it('reports incomplete credentials instead of inventing a workflow', () => {
    const resolved = resolveDeployWorkflow({ CF_API_TOKEN: 'only-token' });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('incomplete_credentials');
    expect(resolved.partial?.found).toEqual(['CF_API_TOKEN']);
    expect(resolved.partial?.missing[0]).toMatch(/account_id/);
  });

  it('refuses when attached vars match no known workflow', () => {
    const resolved = resolveDeployWorkflow({
      SHOPIFY_STORE: 'x.myshopify.com',
      SHOPIFY_ACCESS_TOKEN: 'shpat'
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('no_matching_workflow');
    expect(resolved.attached_var_names).toEqual(['SHOPIFY_ACCESS_TOKEN', 'SHOPIFY_STORE']);
  });

  it('forces Cloudflare when prefer is set even among other vars', () => {
    const resolved = resolveDeployWorkflow(
      {
        SHOPIFY_ACCESS_TOKEN: 'shpat',
        CLOUDFLARE_API_TOKEN: 'tok',
        CLOUDFLARE_ACCOUNT_ID: 'acct'
      },
      'cloudflare_wrangler'
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.resolution.workflow).toBe('cloudflare_wrangler');
  });

  it('advertises env-driven selection in the capabilities manifest', () => {
    const manifest = deployCapabilitiesManifest();
    expect(manifest.tool).toBe('forge_deploy');
    expect(manifest.selection).toBe('from_attached_secret_env_names');
    expect(manifest.alias_tools.cloudflare_wrangler).toBe('forge_cloudflare_deploy');
    expect(DEPLOY_WORKFLOWS[0]?.accepts.api_token).toContain('CF_API_TOKEN');
    expect(manifest.workflows[0]?.accepts_env.account_id).toContain('CF_ACCOUNT_ID');
  });
});
