import { escapeHtml, page } from './ui';
import { vaultService } from './vault';
import { getWebSession, hasForgeAccess } from './github';
import type { Env } from './env';
import type { SecretId, TenantId } from '@forge/core';

function flash(kind: 'ok' | 'bad', message: string): string {
  const bg = kind === 'ok' ? 'var(--ok-bg)' : 'var(--bad-bg)';
  const color = kind === 'ok' ? 'var(--ok)' : 'var(--bad)';
  return `<p class="note" style="padding:.75rem 1rem;border-radius:10px;background:${bg};color:${color};border:1px solid ${color}">${escapeHtml(message)}</p>`;
}

function addSecretForm(error?: string): string {
  return `<section class="section">
  <h2>Add secret</h2>
  <p class="note">Store env vars for a workspace. Values are encrypted and never shown again. Attach from your agent with forge_secret_attach (requires approval).</p>
  ${error ? flash('bad', error) : ''}
  <form method="post" action="/app/secrets" class="secret-form">
    <input type="hidden" name="action" value="create" />
    <label>Label<input name="label" required maxlength="100" placeholder="CF Production" autocomplete="off" /></label>
    <label>Provider
      <select name="provider">
        <option value="generic">generic</option>
        <option value="cloudflare">cloudflare</option>
        <option value="shopify">shopify</option>
      </select>
    </label>
    <fieldset>
      <legend>Environment variables</legend>
      <p class="note">One KEY=value per line. Values are write-only.</p>
      <textarea name="env_text" required rows="6" placeholder="API_TOKEN=&#10;DATABASE_URL=" spellcheck="false"></textarea>
    </fieldset>
    <div class="row"><button type="submit" class="btn primary">Save secret</button></div>
  </form>
</section>`;
}

export function parseEnvText(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new Error(`Invalid line (expected KEY=value): ${trimmed.slice(0, 40)}`);
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`Invalid environment variable name: "${key}".`);
    }
    env[key] = value;
  }
  if (Object.keys(env).length === 0) throw new Error('Add at least one KEY=value line.');
  return env;
}

export async function secretsDashboard(request: Request, env: Env): Promise<Response> {
  const user = await getWebSession(request, env);
  if (!user) {
    return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/login/github?return_to=${encodeURIComponent('/app/secrets')}`, 302);
  }
  if (!hasForgeAccess(user)) {
    return page({ title: 'Forge — secrets', body: '<h1>Secrets</h1><p>You do not have access to this project.</p>', status: 403 });
  }

  const tenantId = user.tenant_id as unknown as TenantId;
  const vault = vaultService(env);
  let notice = '';
  let formError = '';

  if (request.method === 'POST') {
    const form = await request.formData();
    const action = String(form.get('action') ?? '');
    try {
      if (action === 'create') {
        const label = String(form.get('label') ?? '');
        const provider = String(form.get('provider') ?? 'generic') as 'cloudflare' | 'shopify' | 'generic';
        if (!['cloudflare', 'shopify', 'generic'].includes(provider)) {
          throw new Error('Invalid provider.');
        }
        const envVars = parseEnvText(String(form.get('env_text') ?? ''));
        const created = await vault.create(tenantId, label, provider, envVars);
        notice = flash('ok', `Saved “${created.label}” (${created.varNames.length} vars).`);
      } else if (action === 'delete') {
        const secretId = String(form.get('secret_id') ?? '') as SecretId;
        if (!secretId.startsWith('sec_')) throw new Error('Missing secret id.');
        await vault.delete(tenantId, secretId);
        notice = flash('ok', 'Secret deleted.');
      } else {
        throw new Error('Unknown action.');
      }
    } catch (error) {
      formError = error instanceof Error ? error.message : 'Could not save secret.';
    }
  }

  const secrets = await vault.list(tenantId);
  const cards = secrets.length === 0
    ? '<p class="note">No secrets yet. Use the form below.</p>'
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
          <div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">${escapeHtml(secret.label)}</h2><span>${providerBadge} ${stateBadge}</span></div>
          <p style="margin:.4rem 0 0;font-size:.88rem">${varNames}</p>
          <p style="margin:.2rem 0 0;font-size:.78rem;color:var(--muted)">Created ${escapeHtml(created)}</p>
          <form method="post" action="/app/secrets" style="margin-top:.8rem" onsubmit="return confirm('Delete this secret? Workspaces using it will lose the vars.');">
            <input type="hidden" name="action" value="delete" />
            <input type="hidden" name="secret_id" value="${escapeHtml(secret.id)}" />
            <button type="submit" class="btn">Delete</button>
          </form>
        </section>`;
      }).join('\n');

  return page({
    title: 'Forge — secrets',
    topRight: `<a href="/app">Dashboard</a><span>${escapeHtml(user.github_login)}</span><a href="/logout">Sign out</a>`,
    body: `<h1>Secrets</h1>${notice}${cards}${addSecretForm(formError)}`,
    css: `
.section h2{word-break:break-word}
.secret-form{display:grid;gap:.85rem;margin-top:.75rem}
.secret-form label{display:grid;gap:.3rem;font-size:.88rem;color:var(--muted)}
.secret-form input,.secret-form select,.secret-form textarea{
  width:100%;padding:.65rem .75rem;border:1px solid var(--line);border-radius:10px;
  background:var(--bg);color:var(--ink);font:inherit
}
.secret-form textarea{font:.85rem/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
.secret-form fieldset{border:1px solid var(--line);border-radius:12px;padding:.85rem;margin:0}
.secret-form legend{padding:0 .35rem;color:var(--muted);font-size:.82rem}
`
  });
}
