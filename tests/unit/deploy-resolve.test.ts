import { describe, expect, it } from 'vitest';
import {
  DEPLOY_WORKFLOWS,
  applyDeployEnvMap,
  deployCapabilitiesManifest,
  detectDeployWorkflow,
  resolveDeployWorkflow
} from '@forge/application';

describe('agent-driven deploy resolution', () => {
  it('injects attached vars as-is when map_env is omitted', () => {
    const mapped = applyDeployEnvMap(
      {
        CLOUDFLARE_API_TOKEN: 'tok',
        CLOUDFLARE_ACCOUNT_ID: 'acct'
      },
      undefined
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.processEnv).toEqual({
      CLOUDFLARE_API_TOKEN: 'tok',
      CLOUDFLARE_ACCOUNT_ID: 'acct'
    });
    expect(mapped.mapEnv).toEqual({});
  });

  it('lets the agent map CF_KEY onto the Wrangler process env names', () => {
    const resolved = resolveDeployWorkflow({
      attachedVars: {
        CF_KEY: 'alias-token',
        CF_ACCOUNT: 'alias-acct',
        OTHER_KEY: 'keep-me'
      },
      mapEnv: {
        CLOUDFLARE_API_TOKEN: 'CF_KEY',
        CLOUDFLARE_ACCOUNT_ID: 'CF_ACCOUNT'
      },
      command: 'npx wrangler deploy'
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.resolution.workflow).toBe('cloudflare_wrangler');
    expect(resolved.resolution.mapEnv).toEqual({
      CLOUDFLARE_API_TOKEN: 'CF_KEY',
      CLOUDFLARE_ACCOUNT_ID: 'CF_ACCOUNT'
    });
    expect(resolved.resolution.processEnv).toMatchObject({
      CF_KEY: 'alias-token',
      CF_ACCOUNT: 'alias-acct',
      OTHER_KEY: 'keep-me',
      CLOUDFLARE_API_TOKEN: 'alias-token',
      CLOUDFLARE_ACCOUNT_ID: 'alias-acct'
    });
    expect(resolved.resolution.accountId).toBe('alias-acct');
  });

  it('does not invent Cloudflare aliases without map_env', () => {
    const resolved = resolveDeployWorkflow({
      attachedVars: { CF_KEY: 'tok', CF_ACCOUNT: 'acct' },
      command: 'npx wrangler deploy'
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('incomplete_credentials');
    expect(resolved.missing_process_env).toEqual([
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID'
    ]);
    expect(resolved.next_step).toMatch(/map_env/);
  });

  it('rejects map_env sources that are not attached', () => {
    const resolved = resolveDeployWorkflow({
      attachedVars: { CF_KEY: 'tok' },
      mapEnv: {
        CLOUDFLARE_API_TOKEN: 'CF_KEY',
        CLOUDFLARE_ACCOUNT_ID: 'MISSING'
      },
      command: 'npx wrangler deploy'
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('unknown_map_source');
    expect(resolved.unknown_sources).toEqual(['MISSING']);
  });

  it('detects wrangler from the command', () => {
    expect(detectDeployWorkflow('pnpm exec wrangler deploy', {}, 'auto')).toBe(
      'cloudflare_wrangler'
    );
    expect(detectDeployWorkflow('echo hi', {}, 'auto')).toBeNull();
  });

  it('advertises agent map_env selection in capabilities', () => {
    const manifest = deployCapabilitiesManifest();
    expect(manifest.tool).toBe('forge_deploy');
    expect(manifest.selection).toBe('agent_map_env_from_attached_secret_names');
    expect(manifest).not.toHaveProperty('alias_tools');
    expect(DEPLOY_WORKFLOWS[0]?.requires_process_env).toContain('CLOUDFLARE_API_TOKEN');
    expect(manifest.workflows[0]?.requires_process_env).toContain('CLOUDFLARE_ACCOUNT_ID');
  });
});
