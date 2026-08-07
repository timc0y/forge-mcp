import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const origin = (process.env.FORGE_ORIGIN ?? 'https://forge.timcoy.uk').replace(/\/$/, '');
const ownerTokenFile = process.env.FORGE_OWNER_TOKEN_FILE ?? resolve(homedir(), '.config/forge-mcp/cloud-owner-token');
const redirectUri = process.env.FORGE_ACCEPTANCE_REDIRECT_URI ?? 'https://chatgpt.com/forge-acceptance';
const protocolVersion = '2025-11-25';
const configuredRepository = process.env.FORGE_TOOL_TEST_REPOSITORY ?? 'timc0y/forge-mcp';
const [repositoryOwner, repositoryName, repositoryExtra] = configuredRepository.split('/');
if (!repositoryOwner || !repositoryName || repositoryExtra) {
  throw new Error('FORGE_TOOL_TEST_REPOSITORY must be owner/name');
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function randomLabel(prefix = 'probe') {
  return `${prefix}-${Date.now()}-${randomBytes(2).toString('hex')}`;
}

function isTextStream(response) {
  return response.headers.get('content-type')?.includes('text/event-stream');
}

async function responseBody(response, expectedRequestId) {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 1_000)}`);
  }
  if (!body) return undefined;
  if (!isTextStream(response)) return JSON.parse(body);

  const lines = body
    .split(/\r?\n\r?\n/)
    .flatMap((chunk) => chunk.split(/\r?\n/))
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  const messages = lines.map((line) => JSON.parse(line));
  const message = typeof expectedRequestId === 'number'
    ? messages.findLast((item) => item && typeof item === 'object' && item.id === expectedRequestId && ('result' in item || 'error' in item))
    : messages.findLast((item) => item && typeof item === 'object' && ('result' in item || 'error' in item));

  if (!message) {
    throw new Error(`MCP event stream had no JSON-RPC response: ${body.slice(0, 500)}`);
  }

  return message;
}

function normalizedValue(result, keys = ['structuredContent', 'content']) {
  if (!result || typeof result !== 'object') return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (Array.isArray(result.content)) {
    const firstText = result.content.find((entry) => entry && entry.type === 'text' && typeof entry.text === 'string');
    if (firstText) return { text: firstText.text };
  }
  return result;
}

function extractIdLikeText(value, prefix, patternSuffix = '[0-9a-hjkmnp-tv-z]{20,32}') {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(new RegExp(`\\b${prefix}_${patternSuffix}\\b`));
  if (match) return match[0];
  return null;
}

function outcomeText(messageResult) {
  if (messageResult === null || messageResult === undefined) return '';
  if (typeof messageResult === 'string') return messageResult;
  if (typeof messageResult?.text === 'string') return messageResult.text;
  if (Array.isArray(messageResult?.content)) {
    const textEntry = messageResult.content.find((item) => item && item.type === 'text' && typeof item.text === 'string');
    if (textEntry?.text) return textEntry.text;
  }
  if (typeof messageResult?.structuredContent === 'string') return messageResult.structuredContent;
  if (messageResult?.structuredContent?.error?.code) return JSON.stringify(messageResult.structuredContent.error);
  return JSON.stringify(messageResult);
}

function classifyOutcome(message, fallback = 'runtime_fail') {
  if (!message.ok) {
    const errorText = String(message.error?.message || message.error || message.reason || '').toLowerCase();
    if (/forbidden|unauthorized|permission_denied|install/i.test(errorText) || message.error?.code === 'FORGE_PERMISSION_DENIED') {
      return 'permission_fail';
    }
    if (/validation|invalid|required|bad request|schema/i.test(errorText)) return 'validation_fail';
    if (/precondition|not ready|state|not\s+found|quota|provision|offline|resource|forbidden|already|in progress|timeout/i.test(errorText)) {
      return 'precondition_fail';
    }
    return fallback;
  }

  const result = message.result;
  if (!result) return fallback;
  if (result?.isError) {
    const resultText = outcomeText(result).toLowerCase();
    const errorCode = (typeof result?.structuredContent?.error?.code === 'string' ? result.structuredContent.error.code : '').toLowerCase();
    if (errorCode === 'forge_task_not_found' || errorCode === 'forge_artifact_not_found' || errorCode === 'forge_git_push_blocked') {
      return 'precondition_fail';
    }
    if (errorCode === 'forge_internal_error' && /atob\(\)/.test(resultText)) {
      return 'validation_fail';
    }
    if (errorCode === 'forg_permission_denied' || /permission_denied|forbidden|unauthorized|install/i.test(resultText)) {
      return 'permission_fail';
    }
    if (errorCode === 'forge_validation_failed' || /-32602|invalid argument|validation failed|forg[e]?validation|invalid input|invalid value|required/i.test(resultText)) {
      return 'validation_fail';
    }
    if (/precondition|not ready|state|not\s+found|quota|provision|offline|resource|already|in progress|timeout|conflict/i.test(resultText)) {
      return 'precondition_fail';
    }
    return 'tool_fail';
  }

  const resultText = JSON.stringify(result).toLowerCase();
  if (/forge_permission_denied|permission_denied|forbidden|unauthorized/.test(resultText)) return 'permission_fail';
  if (/error/.test(resultText) && !/"iserror":false/i.test(resultText) && !resultText.includes('"result":')) {
    return 'tool_fail';
  }

  return 'success';
}

function repositoryRef() {
  return { provider: 'github', owner: repositoryOwner, name: repositoryName };
}

let activeDefinitions = {};

function valueForArg(name, schema, workspaceId, nested = false, toolName = '') {
  if (name === 'workspace') return workspaceId;
  if (!schema || typeof schema !== 'object') return 'x';

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  if (schema.$ref) {
    const refName = schema.$ref.replace(/^#\/\$defs\//, '');
    const resolvedSchema = activeDefinitions[refName];
    if (resolvedSchema) {
      return valueForArg(name, resolvedSchema, workspaceId, nested, toolName);
    }
    return 'x';
  }

  if (schema.type === 'string') {
    if (name === 'owner') return repositoryOwner;
    if (name === 'name') return repositoryName;
    if (name === 'repository') return `${repositoryOwner}/${repositoryName}`;
    if (name === 'target') return `${repositoryOwner}/${repositoryName}`;
    if (name === 'provider') return nested ? 'github' : 'generic';
    if (name === 'runtime') return 'node-24';
    if (name === 'persistence') return 'ephemeral';
    if (name === 'idempotency_key') return randomLabel('idempotency');
    if (name === 'command') return 'node --version';
    if (name === 'cwd') return '/workspace/repo';
    if (name === 'path' || name === 'filepath' || name === 'file_path') return 'README.md';
    if (name === 'code') return 'code_probe';
    if (name === 'secret_id') return `sec_${randomBytes(4).toString('hex')}0ab12cd34efgh567ij`; // valid shape for testing
    if (name === 'operation_id') return `op_${randomBytes(4).toString('hex')}0ab12c3de4f5h6`; 
    if (name === 'task_id') return `task_${randomBytes(4).toString('hex')}a0b1c2d3e4f5g6h7`; 
    if (name === 'content_base64') return 'aGVsbG8=';
    if (name === 'filename' && toolName === 'forge_artifact_upload') return 'matrix-probe.txt';
    if (name === 'workspace' || name === 'artifact_id' || name === 'approval_id' || name === 'operation') {
      // handled above for workspace; keep specific stable placeholders
    }
    if (name === 'artifact_id') return `art_${randomBytes(4).toString('hex')}0ab12c3de`; 
    if (name === 'approval_id') return `apr_${randomBytes(4).toString('hex')}`;
    if (name === 'process_id') return `proc_${randomBytes(4).toString('hex')}`;
    if (name === 'commit_sha') return 'aaaaaaaaaaaaaaaaaaaa';
    if (name === 'preview_capability') return `pc_${randomBytes(4).toString('hex')}`;
    if (name === 'preview_id') return `prev_${randomBytes(4).toString('hex')}`;
    if (name.endsWith('_id')) return `${name.replace(/^./, 'x')}${randomBytes(4).toString('hex')}`;
    if (name === 'status') return 'ready';
    if (name === 'mode') return 'read_only';
    if (name === 'content') return 'probe-content';
    if (name === 'message' || name === 'description') return 'x';
    if (name === 'access') return 'private';
    if (name === 'environment' || name.includes('token_var') || name === 'pattern') return 'generic';
    if (name === 'persistence') return 'ephemeral';
    if (name === 'repository') return repositoryRef();
    if (name === 'branch') return 'main';

    if (name === 'redirect_uri') return redirectUri;
    if (name === 'scope') return 'forge:workspace';
    if (name.includes('state')) return 'entry';
    if (name === 'route') return '/';
    if (name === 'selection') return 'homepage';

    if (schema.format === 'uri') return 'https://example.com';
    return 'x';
  }

  if (schema.type === 'boolean') {
    return false;
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    if (name === 'timeout_ms') return 8_000;
    if (name === 'limit') return 1;
    if (name === 'port') return 8000;
    if (name === 'output_limit_bytes') return 6_000;
    return 1;
  }

  if (schema.type === 'array') {
    if (name === 'captures') return [{ selection: 'homepage', route: '/', state: 'entry' }];
    if (name === 'viewports') return [{ id: 'phone', width: 390, height: 844 }];
    const itemSchema = schema.items ?? { type: 'string' };
    const item = valueForArg(name, itemSchema, workspaceId, true, toolName);
    return [item];
  }

  if (schema.type === 'object') {
    if (name === 'repository' || name === 'repo' || name === 'repositoryRef') return repositoryRef();
    if (name === 'environment') return {};
    const result = {};
    const props = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const propertyName of required) {
      const childSchema = props[propertyName] ?? { type: 'string' };
      result[propertyName] = valueForArg(propertyName, childSchema, workspaceId, true, toolName);
    }
    return result;
  }

  return 'x';
}

function buildArgs(toolSchema, workspaceId, requiredOnly = true, toolName = '') {
  const input = toolSchema?.inputSchema ?? {};
  const properties = input.properties ?? {};
  const required = input.required ?? [];
  activeDefinitions = input?.$defs ?? {};
  const args = {};

  for (const key of requiredOnly ? required : Object.keys(properties)) {
    if (key in args) continue;
    if (key === 'workspace' && !workspaceId) continue;
    args[key] = valueForArg(key, properties[key], workspaceId, false, toolName);
  }

  if (properties.idempotency_key && args.idempotency_key === undefined) {
    args.idempotency_key = randomLabel('idem');
  }
  if (properties.approved && args.approved === undefined) {
    args.approved = false;
  }
  if (properties.bootstrap && args.bootstrap === undefined) {
    args.bootstrap = false;
  }

  return args;
}

function buildInvalidArgs(toolSchema, workspaceId) {
  const input = toolSchema?.inputSchema ?? {};
  const properties = input.properties ?? {};
  const required = input.required ?? [];
  const args = {};

  const firstKey = required[0] || Object.keys(properties)[0];
  if (firstKey) {
    const schema = properties[firstKey] ?? { type: 'string' };
    const wrong = schema.type === 'string' ? 12345 : schema.type === 'boolean' ? 'true' : schema.type === 'array' ? { invalid: true } : schema.type === 'number' || schema.type === 'integer' ? 'bad' : {};
    args[firstKey] = wrong;
  } else {
    args.__invalid = true;
  }

  if ('workspace' in properties && workspaceId) args.workspace = workspaceId;
  if ('repository' in properties) args.repository = repositoryRef();
  return args;
}

function extractTaskId(result) {
  const maybe = normalizedValue(result);
  if (!maybe) return null;
  if (typeof maybe.task_id === 'string' && /^task_[0-9a-hjkmnp-tv-z]{20,32}$/.test(maybe.task_id)) return maybe.task_id;
  if (typeof maybe.id === 'string' && /^task_[0-9a-hjkmnp-tv-z]{20,32}$/.test(maybe.id)) return maybe.id;
  if (typeof maybe.value === 'string' && /^task_[0-9a-hjkmnp-tv-z]{20,32}$/.test(maybe.value)) return maybe.value;
  if (typeof maybe.text === 'string') return extractIdLikeText(maybe.text, 'task');
  return null;
}

function extractArtifactId(result) {
  const maybe = normalizedValue(result);
  if (!maybe) return null;
  if (typeof maybe.artifact_id === 'string' && /^art_[0-9a-z]+$/.test(maybe.artifact_id)) return maybe.artifact_id;
  if (typeof maybe.id === 'string' && /^art_[0-9a-z]+$/.test(maybe.id)) return maybe.id;
  if (typeof maybe.value === 'string' && /^art_[0-9a-z]+$/.test(maybe.value)) return maybe.value;
  if (typeof maybe.text === 'string') return extractIdLikeText(maybe.text, 'art');
  return null;
}

function toPretty(message) {
  return JSON.stringify(message).slice(0, 400);
}

function extractWorkspaceId(result) {
  const maybe = normalizedValue(result);
  if (!maybe || typeof maybe !== 'object') return null;
  if (typeof maybe.workspace_id === 'string' && maybe.workspace_id) return maybe.workspace_id;
  if (typeof maybe.value === 'string' && maybe.value.startsWith('ws_')) return maybe.value;
  if (typeof maybe.id === 'string' && maybe.id.startsWith('ws_')) return maybe.id;
  if (Array.isArray(maybe.workspace_ids) && maybe.workspace_ids.length > 0) {
    const candidate = maybe.workspace_ids.find((value) => typeof value === 'string' && value.startsWith('ws_'));
    if (candidate) return candidate;
  }
  if (typeof maybe.text === 'string') {
    const match = maybe.text.match(/ws_[A-Za-z0-9]+/);
    if (match) return match[0];
  }
  return null;
}

async function oauth() {
  const ownerToken = (await readFile(ownerTokenFile, 'utf8')).trim();

  const registration = await responseBody(await fetch(`${origin}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Forge Tool Matrix', redirect_uris: [redirectUri] })
  }));

  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());

  const authorization = new URL(`${origin}/oauth/authorize`);
  const fields = {
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'forge:workspace offline_access',
    state: randomLabel('state'),
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
  if (approval.status !== 302) {
    throw new Error(`OAuth approval failed: ${approval.status} ${await approval.text()}`);
  }

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

function createMcpClient(accessToken) {
  let sessionId;
  let requestId = 0;

  async function request(method, params, isNotification = false) {
    const headers = {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'mcp-protocol-version': protocolVersion
    };

    if (sessionId) {
      headers['mcp-session-id'] = sessionId;
    }

    const id = isNotification ? undefined : ++requestId;
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params })
    });

    sessionId ||= response.headers.get('mcp-session-id') ?? undefined;

    if (isNotification) {
      if (response.status >= 400) {
        const body = await response.text();
        if (body) {
          throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 1_000)}`);
        }
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return { ok: true };
    }

    const message = await responseBody(response, id);
    if (message.error) return { ok: false, error: message.error };
    return { ok: true, result: message.result };
  }

  return {
    async init() {
      const init = await request('initialize', {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'forge-tool-matrix', version: '0.1.0' }
      });
      if (!init.ok) throw new Error(`initialize failed: ${toPretty(init.error ?? init.reason)}`);
      await request('notifications/initialized', {}, true);
    },
    request(method, params, isNotification = false) {
      return request(method, params, isNotification);
    },
    call(name, args) {
      return request('tools/call', { name, arguments: args ?? {} });
    }
  };
}

async function waitForWorkspace(mcp, workspaceId, deadlineMs = 90_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const status = await mcp.call('forge_workspace_get', { workspace: workspaceId });
    if (status.ok) {
      const body = normalizedValue(status.result) || {};
      const state = body.state;
      if (state === 'ready' || state === 'failed' || state === 'destroyed') {
        return state;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return 'timeout';
}

function outcomeClass(message) {
  return classifyOutcome(message);
}

function schemaType(schema, definitions = {}) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (typeof schema.type === 'string') return schema.type;
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace(/^#\/\$defs\//u, '');
    return schemaType(definitions[name], definitions);
  }
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((entry) => schemaType(entry, definitions)).sort().join('|');
  return 'unknown';
}

function findSchemaDrift(toolNames, localSchemas, liveSchemas) {
  const drift = [];
  for (const toolName of toolNames) {
    const local = localSchemas[toolName]?.inputSchema;
    const live = liveSchemas[toolName]?.inputSchema;
    if (!local || !live) continue;
    const localProperties = local.properties ?? {};
    const liveProperties = live.properties ?? {};
    for (const property of Object.keys(localProperties)) {
      if (!liveProperties[property]) continue;
      const localType = schemaType(localProperties[property], local.$defs ?? {});
      const liveType = schemaType(liveProperties[property], live.$defs ?? {});
      if (localType !== liveType) drift.push(`${toolName}.${property}: local=${localType} live=${liveType}`);
    }
  }
  return drift;
}

(async function main() {
  const schema = JSON.parse(await readFile(resolve(process.cwd(), 'schemas/forge-tools.schema.json'), 'utf8')).tools;

  const accessToken = await oauth();
  const mcp = createMcpClient(accessToken);
  await mcp.init();

  const remoteToolList = (await mcp.request('tools/list')).result?.tools ?? [];
  const remoteSchemas = Object.fromEntries(
    remoteToolList
      .filter((tool) => tool && typeof tool.name === 'string' && tool.inputSchema)
      .map((tool) => [tool.name, tool])
  );
  const toolNames = [...new Set(Array.isArray(remoteToolList)
    ? remoteToolList.map((tool) => tool?.name).filter((toolName) => typeof toolName === 'string' && toolName.length > 0)
    : Object.keys(schema)
  )].sort();
  const missingFromSchema = toolNames.filter((toolName) => !schema[toolName]);
  if (missingFromSchema.length > 0) {
    console.log('TOOLS_WITHOUT_SCHEMA', missingFromSchema.join(','));
  }
  const schemaDrift = findSchemaDrift(toolNames, schema, remoteSchemas);

  const matrix = [];
  const outcomes = { required: {}, invalid: {} };
  let seededTaskId = null;
  let seededArtifactId = null;

  for (const toolName of toolNames) {
    // The deployed worker is the system under test. Prefer its live schema so
    // a checked-in schema drift cannot turn every required probe into a false
    // validation failure. Keep the generated local schema as a fallback for
    // older workers that omit inputSchema from tools/list.
    const toolSchema = remoteSchemas[toolName] ?? schema[toolName];
    const coldRequiredArgs = buildArgs(toolSchema, undefined, true, toolName);
    const coldInvalidArgs = buildInvalidArgs(toolSchema, undefined);

    const coldRequired = await mcp.call(toolName, coldRequiredArgs);
    const coldInvalid = await mcp.call(toolName, coldInvalidArgs);

    const row = {
      tool: toolName,
      coldRequired,
      coldInvalid,
      coldRequiredOutcome: outcomeClass(coldRequired),
      coldInvalidOutcome: outcomeClass(coldInvalid),
      coldRequiredArgs,
      coldInvalidArgs
    };

    outcomes.required[row.coldRequiredOutcome] = (outcomes.required[row.coldRequiredOutcome] ?? 0) + 1;
    outcomes.invalid[row.coldInvalidOutcome] = (outcomes.invalid[row.coldInvalidOutcome] ?? 0) + 1;

    matrix.push(row);

  }

  if (process.env.FORGE_TOOL_MATRIX_PUBLIC_URL) {
    const screenshot = await mcp.call('forge_screenshot', {
      target: process.env.FORGE_TOOL_MATRIX_PUBLIC_URL,
      paths: ['/'],
      viewports: ['phone', 'tablet', 'desktop'],
      full_page: false,
      time_budget_ms: 40_000
    });
    console.log(`PUBLIC_SCREENSHOT\t${outcomeClass(screenshot)}\t${toPretty(screenshot)}`);
  }

  // The direct-chat matrix must not allocate or poll legacy workspaces. Keep
  // the old acceptance probe available only for explicit historical debugging.
  if (process.env.FORGE_TOOL_MATRIX_LEGACY === '1') {
  const workspaceCreateArgs = buildArgs(schema.forge_workspace_create, undefined);
  workspaceCreateArgs.repository = repositoryRef();
  workspaceCreateArgs.ref = 'main';
  workspaceCreateArgs.runtime = 'node-24';
  workspaceCreateArgs.persistence = 'ephemeral';
  workspaceCreateArgs.bootstrap = false;

  const created = await mcp.call('forge_workspace_create', workspaceCreateArgs);
  const createdState = outcomeClass(created);
  const creationWorkspace = extractWorkspaceId(created.result) || extractWorkspaceId(created);
  if (!creationWorkspace) {
    matrix.push({
      tool: '__workspace_bootstrap__',
      warmRequiredOutcome: createdState,
      warmInvalidOutcome: createdState,
      note: `Could not extract workspace id from response (${toPretty(created)})`
    });
  }

  if (creationWorkspace) {
    const warmState = await waitForWorkspace(mcp, creationWorkspace, 120_000);
    matrix.push({
      tool: '__workspace_state__',
      coldRequiredOutcome: createdState,
      coldInvalidOutcome: 'not_applicable',
      warmRequiredOutcome: warmState,
      warmInvalidOutcome: 'not_applicable',
      note: `workspace ${creationWorkspace}`,
      _meta: created
    });

    if (warmState === 'ready') {
      const artifactBootstrapArgs = buildArgs(schema.forge_artifact_upload, creationWorkspace, true, 'forge_artifact_upload');
      artifactBootstrapArgs.filename = 'tool-matrix-bootstrap.txt';
      artifactBootstrapArgs.content_base64 = 'aGVsbG8=';
      artifactBootstrapArgs.metadata = { source: 'tool-matrix' };
      const artifactBootstrap = await mcp.call('forge_artifact_upload', artifactBootstrapArgs);
      seededArtifactId = extractArtifactId(artifactBootstrap.result) || extractArtifactId(artifactBootstrap);
    }
    
    for (const toolName of toolNames) {
      if (toolName === 'forge_workspace_create') {
        const row = matrix.find((entry) => entry.tool === toolName);
        row.warmRequiredOutcome = 'not_run';
        row.warmInvalidOutcome = 'not_run';
        continue;
      }
      const toolSchema = remoteSchemas[toolName] ?? schema[toolName];
      const warmRequiredArgs = buildArgs(toolSchema, creationWorkspace, true, toolName);
      if ((toolName === 'forge_task_get' || toolName === 'forge_task_update') && seededTaskId) {
        warmRequiredArgs.task_id = seededTaskId;
        if (toolName === 'forge_task_update') {
          warmRequiredArgs.outcome = 'failed';
        }
      }
      if (toolName === 'forge_artifact_get' && seededArtifactId) {
        warmRequiredArgs.artifact_id = seededArtifactId;
      }
      const warmInvalidArgs = buildInvalidArgs(toolSchema, creationWorkspace);

      const warmRequired = await mcp.call(toolName, warmRequiredArgs);
      const warmInvalid = await mcp.call(toolName, warmInvalidArgs);

      const row = matrix.find((entry) => entry.tool === toolName);
      row.warmRequired = warmRequired;
      row.warmInvalid = warmInvalid;
      row.warmRequiredOutcome = outcomeClass(warmRequired);
      row.warmInvalidOutcome = outcomeClass(warmInvalid);

      outcomes.warm_required[row.warmRequiredOutcome] = (outcomes.warm_required[row.warmRequiredOutcome] ?? 0) + 1;
      outcomes.warm_invalid[row.warmInvalidOutcome] = (outcomes.warm_invalid[row.warmInvalidOutcome] ?? 0) + 1;
    }

    if (warmState === 'ready') {
      // Edge case: idempotency replay of workspace create, then cleanup a pre-flight workspace.
      const replay = await mcp.call('forge_workspace_create', {
        ...workspaceCreateArgs,
        repository: repositoryRef(),
        idempotency_key: workspaceCreateArgs.idempotency_key
      });
      matrix.push({
        tool: '__workspace_create_replay__',
        warmRequiredOutcome: outcomeClass(replay),
        note: 'workspace create idempotency replay and duplicate branch protection check'
      });
    }

    await mcp.call('forge_workspace_destroy', {
      workspace: creationWorkspace,
      preserve_artifacts: true,
      force: true,
      idempotency_key: randomLabel('destroy')
    });
  }

  const simulationClient = createMcpClient(await oauth());
  await simulationClient.init();

  const transcript = [];

  transcript.push(['capabilities', outcomeClass(await simulationClient.call('forge_capabilities', {}))]);
  transcript.push(['repositories', outcomeClass(await simulationClient.call('forge_repository_list', {}))]);
  transcript.push(['no_context_workspace_get', outcomeClass(await simulationClient.call('forge_workspace_get', {}))]);
  transcript.push(['no_context_workspace_get_invalid', outcomeClass(await simulationClient.call('forge_workspace_get', { workspace: 'missing-workspace-id' }))]);
  if (creationWorkspace) {
    transcript.push(['minimal_workspace_get', outcomeClass(await simulationClient.call('forge_workspace_get', { workspace: creationWorkspace }))]);
    transcript.push(['minimal_files_list', outcomeClass(await simulationClient.call('forge_files_list', { workspace: creationWorkspace, path: '/' }))]);
    transcript.push(['minimal_files_read', outcomeClass(await simulationClient.call('forge_files_read', { workspace: creationWorkspace, path: 'README.md' }))]);
    transcript.push(['minimal_context_get', outcomeClass(await simulationClient.call('forge_context_get', { workspace: creationWorkspace }))]);
    transcript.push(['minimal_shell', outcomeClass(await simulationClient.call('forge_shell', {
      workspace: creationWorkspace,
      command: 'pwd',
      cwd: '/workspace/repo',
      timeout_ms: 8000,
      environment: {},
      output_limit_bytes: 4000,
      mode: 'read_only'
    }))]);
    transcript.push(['minimal_process_list', outcomeClass(await simulationClient.call('forge_process_list', { workspace: creationWorkspace }))]);
    transcript.push(['no_context_files_list', outcomeClass(await simulationClient.call('forge_files_list', { path: '/' }))]);
    transcript.push(['no_context_files_read', outcomeClass(await simulationClient.call('forge_files_read', { path: 'README.md' }))]);
    transcript.push(['no_context_context_get', outcomeClass(await simulationClient.call('forge_context_get', {}))]);
    transcript.push(['invalid_workspace', outcomeClass(await simulationClient.call('forge_workspace_get', { workspace: 'ws_non_existent' }))]);
  } else {
    transcript.push(['workspace_missing', 'runtime_fail']);
  }
  }

  console.log('TOOL_COUNT', toolNames.length);
  console.log('TOOL_MATRIX_START');
  for (const row of matrix) {
    console.log([row.tool, row.coldRequiredOutcome, row.coldInvalidOutcome].join('\t'));
  }

  console.log('TOOL_MATRIX_SUMMARY_START');
  for (const [scenario, counts] of Object.entries(outcomes)) {
    console.log(`${scenario}\t${JSON.stringify(counts)}`);
  }
  console.log('TOOL_MATRIX_SUMMARY_END');

  if (process.env.FORGE_TOOL_MATRIX_VERBOSE === '1') {
    console.log('TOOL_MATRIX_VERBOSE_START');
    for (const row of matrix) {
      if (row.coldRequiredOutcome === 'validation_fail') {
        console.log(JSON.stringify({
          tool: row.tool,
          coldRequiredArgs: row.coldRequiredArgs,
          coldRequired: row.coldRequired,
        }));
      }
    }
    console.log('TOOL_MATRIX_VERBOSE_END');
  }

  const failures = matrix.filter((row) =>
    row.coldRequiredOutcome === 'tool_fail' ||
    row.coldRequiredOutcome === 'runtime_fail' ||
    row.coldInvalidOutcome === 'tool_fail' ||
    row.coldInvalidOutcome === 'runtime_fail'
  );

  console.log('TOOL_FAIL_RAW_START');
  for (const row of failures) {
    console.log(`${row.tool}\t${row.coldRequiredOutcome}\t${toPretty(row.coldRequired)}\t${row.coldInvalidOutcome}\t${toPretty(row.coldInvalid)}\t${row.warmRequiredOutcome}\t${toPretty(row.warmRequired)}\t${row.warmInvalidOutcome}\t${toPretty(row.warmInvalid)}`);
  }
  console.log('TOOL_FAIL_RAW_END');

  if (schemaDrift.length > 0) {
    console.log('TOOL_SCHEMA_DRIFT_START');
    for (const issue of schemaDrift) console.log(issue);
    console.log('TOOL_SCHEMA_DRIFT_END');
    process.exitCode = 1;
  }

})();
