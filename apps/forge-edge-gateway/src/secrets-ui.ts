import { escapeHtml, page } from './ui';
import { vaultService } from './vault';
import { getWebSession, hasForgeAccess } from './github';
import type { Env } from './env';

export async function secretsDashboard(request: Request, env: Env): Promise<Response> {
  const user = await getWebSession(request, env);
  if (!user) {
    return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/login/github?return_to=${encodeURIComponent('/app/secrets')}`, 302);
  }
  if (!hasForgeAccess(user)) {
    return page({ title: 'Forge — secrets', body: '<h1>Secrets</h1><p>You do not have access to this project.</p>', status: 403 });
  }
  const secrets = await vaultService(env).list(user.tenant_id as unknown as import('@forge/core').TenantId);
  const cards = secrets.length === 0
    ? '<p class="note">No secrets yet. Add one with forge_secret_create from your agent.</p>'
    : secrets.map((secret) => {
        const providerBadge = `<span class="badge">${escapeHtml(secret.provider)}</span>`;
        const stateBadge = secret.state === 'valid'
          ? '<span class="badge" style="background:var(--ok);color:var(--ok-bg)">valid</span>'
          : secret.state === 'invalid'
            ? '<span class="badge" style="background:var(--bad);color:var(--bad-bg)">invalid</span>'
            : '<span class="badge" style="background:var(--muted);color:var(--bg)">unvalidated</span>';
        const varNames = secret.varNames.map((name) => `<code>${escapeHtml(name)}</code>`).join(', ');
        const age = Math.max(0, Math.round((Date.now() - Date.parse(secret.createdAt)) / 86400000));
        const created = age < 1 ? 'today' : `${age}d ago`;
        return `<section class="section">
          <div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">${escapeHtml(secret.label)}</h2>${providerBadge} ${stateBadge}</div>
          <p style="margin:.4rem 0 0;font-size:.88rem">${varNames}</p>
          <p style="margin:.2rem 0 0;font-size:.78rem;color:var(--muted)">Created ${escapeHtml(created)}</p>
        </section>`;
      }).join('\n');
  return page({
    title: 'Forge — secrets',
    topRight: `<span>${escapeHtml(user.github_login)}</span><a href="/logout">Sign out</a>`,
    body: `<h1>Secrets</h1>${cards}`,
    css: `.section h2{word-break:break-word}`
  });
}
