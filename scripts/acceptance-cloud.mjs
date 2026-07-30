import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const origin = (process.env.FORGE_ORIGIN ?? 'https://forge.timcoy.uk').replace(/\/$/, '');
const ownerTokenFile = process.env.FORGE_OWNER_TOKEN_FILE ?? resolve(homedir(), '.config/forge-mcp/cloud-owner-token');
// Production DCR correctly rejects loopback callbacks: a remotely reachable
// service must not issue authorization codes to an arbitrary machine's local
// listener. This acceptance client consumes the 302 manually and never follows
// it, so use a stable, allow-listed HTTPS callback by default. Operators can
// still override it for a controlled integration environment.
const redirectUri = process.env.FORGE_ACCEPTANCE_REDIRECT_URI ?? 'https://chatgpt.com/forge-acceptance';
const protocolVersion = '2025-11-25';
const recoveryWaitMs = Number.parseInt(process.env.FORGE_RECOVERY_WAIT_MS ?? '100000', 10);
const acceptanceStartedAt = new Date().toISOString();
const configuredRepository = process.env.FORGE_ACCEPTANCE_REPOSITORY ?? 'mdn/beginner-html-site-styled';
const [repositoryOwner, repositoryName, extraRepositorySegment] = configuredRepository.split('/');
const requireGitHubApp = process.env.FORGE_ACCEPTANCE_REQUIRE_GITHUB_APP === 'true';

if (!repositoryOwner || !repositoryName || extraRepositorySegment) {
  throw new Error('FORGE_ACCEPTANCE_REPOSITORY must be an owner/name GitHub repository slug.');
}
if (requireGitHubApp && configuredRepository === 'mdn/beginner-html-site-styled') {
  throw new Error('FORGE_ACCEPTANCE_REQUIRE_GITHUB_APP=true requires FORGE_ACCEPTANCE_REPOSITORY to name an installed private repository.');
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function responseBody(response, expectedRequestId) {
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
  // Streamable HTTP can append progress/auxiliary events after the tool
  // response. Bind the stream frame to the exact JSON-RPC request id; choosing
  // the last frame (or merely one with a result-like field) can turn a real
  // successful destroy into `{ value: undefined }`.
  const messages = data.map((line) => JSON.parse(line));
  const rpcResponse = typeof expectedRequestId === 'number'
    ? messages.findLast((message) => message && typeof message === 'object' && message.id === expectedRequestId && ('result' in message || 'error' in message))
    : messages.findLast((message) => message && typeof message === 'object' && ('result' in message || 'error' in message));
  if (!rpcResponse) throw new Error(`MCP event stream had no JSON-RPC response: ${body.slice(0, 500)}`);
  return rpcResponse;
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
    const jsonRpcId = notification ? undefined : ++requestId;
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(jsonRpcId === undefined ? {} : { id: jsonRpcId }), method, params })
    });
    sessionId ??= response.headers.get('mcp-session-id') ?? undefined;
    const message = await responseBody(response, jsonRpcId);
    if (message?.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(message.error)}`);
    return message;
  }
  await request('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'forge-cloud-acceptance', version: '0.1.0' }
  });
  await request('notifications/initialized', {}, true);
  return {
    async call(name, args) {
      const message = await request('tools/call', { name, arguments: args });
      const result = message?.result;
      if (!result || typeof result !== 'object') {
        throw new Error(`${name} returned an invalid MCP tool result: ${JSON.stringify(message).slice(0, 2_000)}`);
      }
      if (result?.isError) throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent)}`);
      return { value: result?.structuredContent, content: result?.content ?? [] };
    }
  };
}

function key(label) {
  return `acceptance-${label}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

function imageDimensions(data) {
  const bytes = Buffer.from(data, 'base64');
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(signature)) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // Forge intentionally defaults review evidence to JPEG for lower R2 and MCP
  // payload cost. Read JPEG start-of-frame dimensions without a native image
  // dependency so this production acceptance test verifies both supported
  // image formats.
  if (bytes.length >= 9 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      const startOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (startOfFrame) {
        return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      }
      offset += length;
    }
  }
  throw new Error('Browser evidence was neither a valid PNG nor a valid JPEG.');
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
if (process.env.FORGE_ACCEPTANCE_READ_ONLY === 'true') {
  const capabilities = await mcp.call('forge_capabilities', {});
  const repositories = await mcp.call('forge_repository_list', {});
  const capabilityValue = capabilities.value && typeof capabilities.value === 'object' ? capabilities.value : {};
  const repositoryValue = repositories.value && typeof repositories.value === 'object' ? repositories.value : {};
  const repositoryRows = Array.isArray(repositoryValue.repositories) ? repositoryValue.repositories : [];
  process.stdout.write(`Forge MCP read-only smoke passed: ${Object.keys(capabilityValue).length} capability fields, ${repositoryRows.length} repositories.\n`);
  process.exit(0);
}
const cleanupWorkspace = process.env.FORGE_CLEANUP_WORKSPACE;
if (cleanupWorkspace) {
  const inspected = await mcp.call('forge_workspace_get', { workspace: cleanupWorkspace }).catch((error) => ({ value: { inspection_error: String(error) } }));
  console.log(inspected.value.inspection_error
    ? `workspace ${cleanupWorkspace}: inspection unavailable; proceeding with force cleanup`
    : `workspace ${cleanupWorkspace}: current state ${inspected.value.state}${inspected.value.failure ? ` ${JSON.stringify(inspected.value.failure)}` : ''}`);
  const cleanup = await mcp.call('forge_workspace_destroy', {
    workspace: cleanupWorkspace,
    preserve_artifacts: true,
    force: true,
    idempotency_key: key('cleanup')
  });
  if (!cleanup.value || typeof cleanup.value !== 'object') {
    throw new Error('forge_workspace_destroy did not return structured workspace state.');
  }
  process.stdout.write(`workspace ${cleanupWorkspace}: ${cleanup.value.state}\n`);
  await new Promise((resolveFlush) => setImmediate(resolveFlush));
}

if (!cleanupWorkspace) {
let workspaceId;
let destroyed = false;
let previewAccess;

try {
  const created = await mcp.call('forge_workspace_create', {
    repository: { provider: 'github', owner: repositoryOwner, name: repositoryName },
    ref: 'main',
    runtime: 'node-24',
    persistence: 'ephemeral',
    bootstrap: false,
    idempotency_key: key('create')
  });
  workspaceId = created.value.workspace_id;
  console.log(`workspace ${workspaceId}: ${created.value.state}`);
  if (created.value.state === 'requested') {
    const firstExecution = await mcp.call('forge_shell', {
      workspace: workspaceId,
      command: 'node --version',
      cwd: '/workspace/repo',
      timeout_ms: 30_000,
      environment: {},
      network_policy: 'deny_all',
      output_limit_bytes: 20_000,
      mode: 'read_only',
      idempotency_key: key('lazy-provision')
    }).then(
      () => ({ unexpectedlyRan: true, message: '' }),
      (error) => ({ unexpectedlyRan: false, message: String(error) })
    );
    if (firstExecution.unexpectedlyRan || !/executor is starting|provisioning/iu.test(firstExecution.message)) {
      throw new Error(`First execution call did not return the lazy-provisioning receipt: ${firstExecution.message}`);
    }
  }
  const ready = await waitFor(
    async () => (await mcp.call('forge_workspace_get', { workspace: workspaceId })).value,
    'workspace readiness',
    (value) => value.state === 'ready' || value.state === 'failed'
  );
  if (ready.state !== 'ready') throw new Error(`Workspace provisioning failed: ${JSON.stringify(ready)}`);

  if (!Number.isFinite(recoveryWaitMs) || recoveryWaitMs < 95_000) {
    throw new Error('FORGE_RECOVERY_WAIT_MS must be at least 95000 to verify the 90-second Sandbox sleep/restore path.');
  }
  console.log(`waiting ${recoveryWaitMs}ms to verify durable Sandbox sleep recovery`);
  await new Promise((resolveWait) => setTimeout(resolveWait, recoveryWaitMs));
  const recovered = await mcp.call('forge_workspace_get', { workspace: workspaceId });
  if (
    recovered.value.state !== 'ready' ||
    !recovered.value.activeSnapshotId ||
    !recovered.value.recovery?.verifiedAt ||
    Date.parse(recovered.value.recovery.verifiedAt) < Date.parse(acceptanceStartedAt)
  ) {
    throw new Error(`Workspace did not recover from idle sleep: ${JSON.stringify(recovered.value)}`);
  }
  const recoveryReady = await fetch(`${origin}/ready`);
  const recoveryStatus = await recoveryReady.json();
  if (
    !recoveryReady.ok ||
    recoveryStatus.recovery?.verified !== true ||
    recoveryStatus.recovery?.workspaceId !== workspaceId ||
    Date.parse(recoveryStatus.recovery?.verifiedAt ?? '') < Date.parse(acceptanceStartedAt)
  ) {
    throw new Error(`Gateway did not record a manifest-verified recovery: ${JSON.stringify(recoveryStatus)}`);
  }

  const command = await mcp.call('forge_shell', {
    workspace: workspaceId,
    command: "node --version && git rev-parse --short HEAD && git remote get-url origin && test -f index.html",
    cwd: '/workspace/repo',
    timeout_ms: 30_000,
    environment: {},
    network_policy: 'deny_all',
    output_limit_bytes: 20_000,
    idempotency_key: key('shell'),
    approved: false
  });
  if (command.value.exitCode !== 0) throw new Error(`Workspace command failed: ${JSON.stringify(command.value)}`);
  if (requireGitHubApp && !String(command.value.stdout ?? '').includes(`${origin}/git/${workspaceId}/`)) {
    throw new Error(`Workspace did not clone through the Forge GitHub App proxy: ${JSON.stringify(command.value)}`);
  }

  const process = await mcp.call('forge_shell', {
    workspace: workspaceId,
    command: 'python3 -m http.server 8000 --bind 0.0.0.0',
    cwd: '/workspace/repo',
    environment: {},
    network_policy: 'deny_all',
    async: true,
    idempotency_key: key('server')
  });
  const processId = process.value.value?.id ?? process.value.processId ?? process.value.process_id;
  if (!processId) throw new Error(`Process start did not return an ID: ${JSON.stringify(process.value)}`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));

  const preview = await mcp.call('forge_preview_expose', {
    workspace: workspaceId,
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

  const review = await mcp.call('forge_preview', {
    workspace: workspaceId,
    preview_id: previewId,
    captures: [{ selection: 'homepage', route: '/', state: 'entry' }],
    viewports: [
      { id: 'phone', width: 390, height: 844 },
      { id: 'desktop', width: 1440, height: 900 }
    ]
  });
  if (
    review.value.schemaVersion !== 1 ||
    review.value.capturedCount !== 2 ||
    review.value.evidence?.length !== 2
  ) {
    throw new Error(`Review capture was incomplete: ${JSON.stringify(review.value)}`);
  }
  if (!review.value.evidence.every((item) => Number.isInteger(item.findingCount))) {
    throw new Error(`Review evidence omitted its structure-health signal: ${JSON.stringify(review.value.evidence)}`);
  }
  const images = review.content.filter((content) => content.type === 'image');
  if (images.length !== 2) {
    throw new Error(`Review capture returned ${images.length} inline images for two requested viewports.`);
  }
  for (const image of images) {
    const dimensions = imageDimensions(image.data);
    if (!review.value.evidence.some((item) => {
      const viewport = item.observedViewport ?? item.requestedViewport;
      return viewport?.width === dimensions.width && viewport?.height === dimensions.height;
    })) {
      throw new Error(`Inline screenshot dimensions ${dimensions.width}x${dimensions.height} did not match evidence metadata.`);
    }
  }
  console.log(JSON.stringify({
    ok: true,
    workspace_id: workspaceId,
    repository: review.value.repository,
    commit: review.value.commit,
    evidence: review.value.evidence.map((item) => ({
      environment: item.environment,
      finding_count: item.findingCount,
      viewport: item.observedViewport ?? item.requestedViewport
    }))
  }, null, 2));
} finally {
  if (workspaceId) {
    const result = await mcp.call('forge_workspace_destroy', {
      workspace: workspaceId,
      preserve_artifacts: true,
      force: true,
      idempotency_key: key('destroy')
    }).catch((error) => ({ value: { error: String(error) } }));
    let reportedState = result.value.state;
    if (reportedState === 'destroying') {
      const finalState = await waitFor(
        async () => (await mcp.call('forge_workspace_get', { workspace: workspaceId })).value,
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
}
