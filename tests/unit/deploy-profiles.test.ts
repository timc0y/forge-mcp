import { describe, expect, it } from 'vitest';
import {
  hashDeployProfile,
  planCloudflareDeployProfile
} from '@forge/application';

const repository = { provider: 'github' as const, owner: 'acme', name: 'web' };

describe('deploy profile planning', () => {
  it('plans a root wrangler.toml deploy', async () => {
    const plan = await planCloudflareDeployProfile({
      repository,
      files: [{ path: 'wrangler.toml', content: 'name = "acme-web"\n' }]
    });
    expect(plan.state).toBe('ready_to_approve');
    if (plan.state !== 'ready_to_approve') return;
    expect(plan.draft.cwd).toBe('/workspace/repo');
    expect(plan.draft.command).toBe('npx wrangler deploy');
    expect(plan.draft.expected_worker_name).toBe('acme-web');
    expect(plan.draft.map_env).toEqual({ CLOUDFLARE_API_TOKEN: 'CLOUDFLARE_API_TOKEN' });
  });

  it('plans a nested wrangler config with cwd and explicit config path', async () => {
    const plan = await planCloudflareDeployProfile({
      repository,
      files: [{ path: 'apps/worker/wrangler.toml', content: 'name = "nested"\n' }]
    });
    expect(plan.state).toBe('ready_to_approve');
    if (plan.state !== 'ready_to_approve') return;
    expect(plan.draft.cwd).toBe('/workspace/repo/apps/worker');
    expect(plan.draft.command).toBe('npx wrangler deploy');
  });

  it('prefers package deploy scripts over config defaults', async () => {
    const plan = await planCloudflareDeployProfile({
      repository,
      files: [
        { path: 'wrangler.toml', content: 'name = "root"\n' },
        { path: 'apps/worker/package.json', content: JSON.stringify({ scripts: { deploy: 'wrangler deploy --env production' } }) }
      ]
    });
    expect(plan.state).toBe('ready_to_approve');
    if (plan.state !== 'ready_to_approve') return;
    expect(plan.draft.command).toBe('pnpm --filter worker deploy');
    expect(plan.draft.cwd).toBe('/workspace/repo/apps/worker');
  });

  it('prefers .forge/deploy.json hints over inferred commands', async () => {
    const plan = await planCloudflareDeployProfile({
      repository,
      files: [
        { path: 'wrangler.toml', content: 'name = "root"\n' },
        {
          path: '.forge/deploy.json',
          content: JSON.stringify({
            label: 'prod worker',
            cwd: 'apps/worker',
            command: 'pnpm wrangler deploy --env production',
            environment: 'production',
            expected_worker_name: 'prod-worker'
          })
        }
      ]
    });
    expect(plan.state).toBe('ready_to_approve');
    if (plan.state !== 'ready_to_approve') return;
    expect(plan.draft.label).toBe('prod worker');
    expect(plan.draft.cwd).toBe('/workspace/repo/apps/worker');
    expect(plan.draft.command).toBe('pnpm wrangler deploy --env production');
    expect(plan.draft.environment).toBe('production');
  });

  it('asks for a user choice when several configs are plausible', async () => {
    const plan = await planCloudflareDeployProfile({
      repository,
      files: [
        { path: 'apps/a/wrangler.toml', content: 'name = "a"\n' },
        { path: 'apps/b/wrangler.toml', content: 'name = "b"\n' }
      ]
    });
    expect(plan.state).toBe('needs_user_choice');
    if (plan.state !== 'needs_user_choice') return;
    expect(plan.candidates).toHaveLength(2);
  });

  it('hash changes when the approved deploy shape changes', async () => {
    const base = {
      label: 'prod',
      repository,
      workflow: 'cloudflare_wrangler' as const,
      environment: 'production' as const,
      cwd: '/workspace/repo',
      command: 'npx wrangler deploy',
      map_env: { CLOUDFLARE_API_TOKEN: 'CLOUDFLARE_API_TOKEN' },
      source_hint: 'wrangler.toml'
    };
    await expect(hashDeployProfile(base)).resolves.toBe(await hashDeployProfile(base));
    await expect(hashDeployProfile({ ...base, command: 'pnpm deploy' })).resolves.not.toBe(await hashDeployProfile(base));
  });
});
