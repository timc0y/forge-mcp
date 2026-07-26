import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.FORGE_GITHUB_APP_SETUP_PORT ?? 43119);
const origin = process.env.FORGE_ORIGIN ?? 'https://forge.timcoy.uk';
const state = randomBytes(24).toString('hex');
const configDirectory = join(homedir(), '.config', 'forge-mcp');

const manifest = {
  name: 'Forge MCP Cloud',
  url: origin,
  description: 'Secure remote development workspaces and Parallax review evidence for AI coding agents.',
  hook_attributes: { url: `${origin}/github/webhooks`, active: true },
  redirect_url: `http://127.0.0.1:${port}/callback`,
  callback_urls: [`${origin}/login/github/callback`],
  setup_url: `${origin}/github/setup`,
  setup_on_update: true,
  // Forge's private-pilot workflow is deliberately owner-installed. The owner
  // installs this App on the selected repositories, then approves Forge access
  // for collaborators. This avoids exposing a public installation surface just
  // so a small trusted team can use the service.
  public: false,
  default_permissions: { contents: 'write', pull_requests: 'write' },
  // Installation lifecycle events are implicit and GitHub rejects them when
  // explicitly listed in an App manifest.
  default_events: ['push', 'pull_request'],
  request_oauth_on_install: false,
};

function page(body) {
  return `<!doctype html><meta charset="utf-8"><title>Forge GitHub App setup</title><style>body{font:16px system-ui;max-width:680px;margin:12vh auto;padding:24px;line-height:1.5}button{font:inherit;padding:12px 18px}</style>${body}`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(page(`<h1>Create Forge MCP Cloud</h1><p>GitHub will show the final permissions before creation. Credentials return only to this local process and are written with owner-only permissions.</p><form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value='${JSON.stringify(manifest).replaceAll("'", '&#39;')}'><button>Create GitHub App</button></form>`));
    return;
  }
  if (url.pathname !== '/callback') {
    response.statusCode = 404;
    response.end('Not found');
    return;
  }
  const returnedState = url.searchParams.get('state') ?? '';
  const validState = returnedState.length === state.length && timingSafeEqual(Buffer.from(returnedState), Buffer.from(state));
  const code = url.searchParams.get('code');
  if (!validState || !code) {
    response.statusCode = 400;
    response.end(page('<h1>Invalid GitHub callback</h1>'));
    return;
  }
  const conversion = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10', 'user-agent': 'forge-mcp-setup' },
  });
  if (!conversion.ok) {
    response.statusCode = 502;
    response.end(page(`<h1>Credential exchange failed</h1><p>GitHub returned HTTP ${conversion.status}.</p>`));
    return;
  }
  const app = await conversion.json();
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const configPath = join(configDirectory, 'github-app.json');
  const keyPath = join(configDirectory, 'github-app-private-key.pem');
  await writeFile(configPath, `${JSON.stringify({ id: app.id, client_id: app.client_id, client_secret: app.client_secret, slug: app.slug, webhook_secret: app.webhook_secret }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(keyPath, app.pem, { mode: 0o600 });
  await chmod(configPath, 0o600);
  await chmod(keyPath, 0o600);
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(page(`<h1>Forge GitHub App created</h1><p>Credentials were stored locally with owner-only permissions. You may close this tab.</p><p>App: <strong>${app.slug}</strong></p>`));
  process.stdout.write(`CREATED app_id=${app.id} client_id=${app.client_id} slug=${app.slug}\n`);
  setTimeout(() => server.close(), 250);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`OPEN http://127.0.0.1:${port}/\n`);
});
