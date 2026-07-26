import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const origin = (process.env.FORGE_ORIGIN ?? 'https://forge-edge-gateway.timcoy72.workers.dev').replace(/\/$/, '');
const ownerTokenFile = process.env.FORGE_OWNER_TOKEN_FILE ?? resolve(homedir(), '.config/forge-mcp/cloud-owner-token');
const redirectUri = 'http://127.0.0.1:47123/callback';
const protocolVersion = '2025-11-25';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function responseBody(response) {
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 1_000)}`);
  if (!body) return undefined;
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return JSON.parse(body);
  const data = body
    .split(/\r?\n\r?\n/)
    .flatMap((event) => event.split(/\r?\n/))
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (data.length === 0) throw new Error(`MCP returned an empty event stream: ${body.slice(0, 500)}`);
  return JSON.parse(data.at(-1));
}

async function oauth() {
  const ownerToken = (await readFile(ownerTokenFile, 'utf8')).trim();
  const registration = await responseBody(await fetch(`${origin}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Forge cloud acceptance', redirect_uris: [redirectUri] })
  }));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const authorization = new URL(`${origin}/oauth/authorize`);
  const fields = {
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'forge:workspace offline_access',
    state: base64url(randomBytes(16)),
    code_challenge: challenge,
    code_challenge_method: 'S256'
  };
  for (const [key, value] of Object.entries(fields)) authorization.searchParams.set(key, value);
  const approval = await fetch(authorization, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, token: ownerToken })
  });
  if (approval.status !== 302) throw new Error(`OAuth approval failed: ${approval.status} ${await approval.text()}`);
  const callback = new URL(approval.headers.get('location'));
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('OAuth approval did not return an authorization code.');
  const tokens = await responseBody(await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier
    })
  }));
  return tokens.access_token;
}

async function connect(accessToken) {
  let sessionId;
  let requestId = 0;
  async function request(method, params, notification = false) {
    const headers = {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'mcp-protocol-version': protocolVersion
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++requestId }), method, params })
    });
    sessionId ??= response.headers.get('mcp-session-id') ?? undefined;
    const message = await responseBody(response);
    if (message?.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(message.error)}`);
    return message?.result;
  }
  await request('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'forge-cloud-acceptance', version: '0.1.0' }
  });
  await request('notifications/initialized', {}, true);
  return {
    async call(name, args) {
      const result = await request('tools/call', { name, arguments: args });
      if (result?.isError) throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent)}`);
      return { value: result?.structuredContent, content: result?.content ?? [] };
    }
  };
}

function key(label) {
  return `acceptance-${label}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

function pngDimensions(data) {
  const bytes = Buffer.from(data, 'base64');
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error('Browser artifact was not a valid PNG.');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function waitFor(call, description, predicate, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await call();
    if (predicate(value)) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 4_000));
  }
  throw new Error(`Timed out waiting for ${description}. Last value: ${JSON.stringify(value)}`);
}

const accessToken = await oauth();
const mcp = await connect(accessToken);
const cleanupWorkspace = process.env.FORGE_CLEANUP_WORKSPACE;
if (cleanupWorkspace) {
  const cleanup = await mcp.call('forge_workspace_destroy', {
    workspace_id: cleanupWorkspace,
    preserve_artifacts: true,
    idempotency_key: key('cleanup')
  });
  console.log(`workspace ${cleanupWorkspace}: ${cleanup.value.state}`);
  process.exit(0);
}
let workspaceId;
let destroyed = false;
let previewAccess;

try {
  const created = await mcp.call('forge_workspace_create', {
    repository: { provider: 'github', owner: 'mdn', name: 'beginner-html-site-styled' },
    ref: 'main',
    runtime: 'node-24',
    persistence: 'ephemeral',
    bootstrap: false,
    idempotency_key: key('create')
  });
  workspaceId = created.value.workspace_id;
  console.log(`workspace ${workspaceId}: ${created.value.state}`);
  const ready = await waitFor(
    async () => (await mcp.call('forge_workspace_get', { workspace_id: workspaceId })).value,
    'workspace readiness',
    (value) => value.state === 'ready' || value.state === 'failed'
  );
  if (ready.state !== 'ready') throw new Error(`Workspace provisioning failed: ${JSON.stringify(ready)}`);

  const command = await mcp.call('forge_shell_exec', {
    workspace_id: workspaceId,
    command: "node --version && git rev-parse --short HEAD && test -f index.html",
    cwd: '/workspace/repo',
    timeout_ms: 30_000,
    environment: {},
    network_policy: 'deny_all',
    output_limit_bytes: 20_000,
    idempotency_key: key('shell'),
    approved: false
  });
  if (command.value.exitCode !== 0) throw new Error(`Workspace command failed: ${JSON.stringify(command.value)}`);

  const process = await mcp.call('forge_process_start', {
    workspace_id: workspaceId,
    command: 'python3 -m http.server 8000 --bind 0.0.0.0',
    cwd: '/workspace/repo',
    environment: {},
    network_policy: 'deny_all',
    idempotency_key: key('server')
  });
  const processId = process.value.value?.id ?? process.value.processId ?? process.value.process_id;
  if (!processId) throw new Error(`Process start did not return an ID: ${JSON.stringify(process.value)}`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));

  const preview = await mcp.call('forge_preview_expose', {
    workspace_id: workspaceId,
    process_id: processId,
    port: 8000,
    access: 'private',
    ttl_seconds: 600,
    idempotency_key: key('preview')
  });
  const previewId = preview.value.previewId ?? preview.value.preview_id;
  if (!previewId) throw new Error(`Preview exposure did not return an ID: ${JSON.stringify(preview.value)}`);
  previewAccess = {
    url: preview.value.preview_url,
    header: preview.value.preview_capability_header,
    capability: preview.value.preview_capability,
    previewId
  };
  const unscopedBrowser = await fetch(`${origin}/__forge_browser/${workspaceId}/${previewId}/`, {
    headers: {
      'x-forge-browser-workspace': workspaceId,
      'x-forge-browser-preview': previewId
    }
  });
  if (unscopedBrowser.status !== 403) {
    throw new Error(`Internal browser bridge accepted an unscoped request: ${unscopedBrowser.status}`);
  }
  const unauthorizedPreview = await fetch(previewAccess.url);
  if (unauthorizedPreview.status !== 403) {
    throw new Error(`Private preview accepted a request without its capability: ${unauthorizedPreview.status}`);
  }
  const authorizedPreview = await fetch(previewAccess.url, {
    headers: { [previewAccess.header]: previewAccess.capability }
  });
  if (!authorizedPreview.ok || !(await authorizedPreview.text()).includes('Mozilla')) {
    throw new Error(`Private preview did not render through its scoped capability: ${authorizedPreview.status}`);
  }

  const review = await mcp.call('forge_review_capture', {
    workspace_id: workspaceId,
    preview_id: previewId,
    captures: [{ selection: 'homepage', route: '/', state: 'entry' }],
    viewports: [
      { id: 'phone', width: 390, height: 844 },
      { id: 'desktop', width: 1440, height: 900 }
    ]
  });
  if (review.value.schemaVersion !== 1 || review.value.evidence?.length !== 2) {
    throw new Error(`Review capture was incomplete: ${JSON.stringify(review.value)}`);
  }
  if (!review.value.evidence.every((item) => JSON.stringify(item.accessibility).includes('Mozilla'))) {
    throw new Error('Review evidence did not contain the target site accessibility content.');
  }
  for (const item of review.value.evidence) {
    const artifact = await mcp.call('forge_artifact_get', {
      workspace_id: workspaceId,
      artifact_id: item.screenshot.artifactId,
      max_bytes: 4_000_000
    });
    const image = artifact.content.find((content) => content.type === 'image');
    if (!image) {
      throw new Error(`Artifact ${item.screenshot.artifactId} did not return MCP image content.`);
    }
    const dimensions = pngDimensions(image.data);
    if (
      dimensions.width !== item.screenshot.width ||
      dimensions.height !== item.screenshot.height
    ) {
      throw new Error(
        `Artifact ${item.screenshot.artifactId} dimensions did not match its evidence metadata.`
      );
    }
  }
  console.log(JSON.stringify({
    ok: true,
    workspace_id: workspaceId,
    repository: review.value.repository,
    commit: review.value.commit,
    evidence: review.value.evidence.map((item) => ({
      environment: item.environment,
      artifact_id: item.screenshot.artifactId,
      width: item.screenshot.width,
      height: item.screenshot.height
    }))
  }, null, 2));
} finally {
  if (workspaceId) {
    const result = await mcp.call('forge_workspace_destroy', {
      workspace_id: workspaceId,
      preserve_artifacts: true,
      idempotency_key: key('destroy')
    }).catch((error) => ({ value: { error: String(error) } }));
    let reportedState = result.value.state;
    if (reportedState === 'destroying') {
      const finalState = await waitFor(
        async () => (await mcp.call('forge_workspace_get', { workspace_id: workspaceId })).value,
        'workspace destruction',
        (value) => value.state === 'destroyed' || value.state === 'failed',
        120_000
      );
      destroyed = finalState.state === 'destroyed';
      reportedState = finalState.state;
    } else {
      destroyed = reportedState === 'destroyed';
    }
    if (destroyed && previewAccess) {
      const revokedPreview = await fetch(previewAccess.url, {
        headers: { [previewAccess.header]: previewAccess.capability }
      });
      if (revokedPreview.ok) {
        destroyed = false;
        console.error(`destroyed workspace preview still returned ${revokedPreview.status}`);
      }
    }
    console.log(`workspace ${workspaceId}: ${reportedState ?? result.value.error}`);
  }
  if (workspaceId && !destroyed) process.exitCode = 1;
}
