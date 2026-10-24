import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const requiredSecrets = ['GITHUB_APP_CLIENT_SECRET', 'FORGE_SIGNING_KEY', 'CLOUDFLARE_API_TOKEN', 'TYPESAFE_API_KEY'];
const placeholder = /REPLACE[_-]|replace-me|placeholder|example\.(?:com|org|net)|<[^>]+>/i;
const maintainer = /timcoy|timc0y|forge-v1-(?:production|development)|forge-mcp-github-app|Iv23limnLx32EUIdhl3Y|04d3e478b1ddf0f5147120cacbf430de|d6784b5908746881ddb313d17efd5cc2|403cb9a9-cac2-424e-a075-905c49fc3306|366320dc-0d18-46c9-86cc-6713a51f295b/i;
const hexId = /^[0-9a-f]{32}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const positiveInteger = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));

export function parseConfig(text) {
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
  // Parser diagnostics can contain the input. Never echo them or config values.
  if (parsed.error || !parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) throw new Error('Config is not a JSONC object.');
  return parsed.config;
}

export function parseSecrets(text) {
  const secrets = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line.trim());
    if (!match) throw new Error('Secrets file must contain one NAME=value per line.');
    const [, name, raw] = match;
    let value;
    if (raw.startsWith('"')) {
      try { value = JSON.parse(raw); } catch { throw new Error('Secrets file has invalid double quoting.'); }
    } else if (raw.startsWith("'")) {
      if (!raw.endsWith("'")) throw new Error('Secrets file has invalid single quoting.');
      value = raw.slice(1, -1);
    } else value = raw.replace(/\s+#.*$/, '').trim();
    if (typeof value !== 'string') throw new Error('Secrets file values must be strings.');
    secrets[name] = value;
  }
  return secrets;
}

export function checkConfig(config, { secrets = {}, configOnly = false, local = false } = {}) {
  const errors = [];
  const fail = message => errors.push(message);
  const serialized = JSON.stringify(config);
  if (placeholder.test(serialized)) fail('Replace all configuration placeholders.');
  if (maintainer.test(serialized)) fail('Remove maintainer identifiers, domains and resources.');
  if (config.env && Object.keys(config.env).length) fail('Use one self-host config without named environments.');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.name ?? '')) fail('Set a valid own Worker name.');
  if (!hexId.test(config.account_id ?? '')) fail('Set your 32-character Cloudflare account_id.');
  if (config.main !== 'src/index.ts') fail('main must be src/index.ts.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date ?? '')) fail('Set compatibility_date.');
  if (!config.compatibility_flags?.includes('nodejs_compat')) fail('Keep nodejs_compat.');
  if (config.build?.command !== 'node scripts/build-parser.mjs' || config.alias?.typescript !== './.wrangler/typescript-parser.mjs') fail('Keep the existing Worker parser build and alias.');
  const vars = config.vars ?? {};
  const allowedLogins = vars.FORGE_ALLOWED_LOGINS;
  if (typeof allowedLogins !== 'string' || !allowedLogins.trim() || allowedLogins.split(',').some(login => login.trim().length > 39 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(login.trim()))) fail('Set FORGE_ALLOWED_LOGINS to a nonempty list of explicit GitHub logins; no wildcard. Missing, blank or invalid runtime values deny all access.');
  if (vars.CLOUDFLARE_ACCOUNT_ID !== config.account_id) fail('CLOUDFLARE_ACCOUNT_ID must match account_id.');
  if (vars.FORGE_UNLIMITED_LOGINS?.trim()) fail('Remove capture-quota exemptions from the self-host config.');
  const captureLogins = vars.FORGE_CAPTURE_ALLOWED_LOGINS;
  if (typeof captureLogins !== 'string' || (captureLogins.trim() && captureLogins.split(',').some(login => !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(login.trim())))) fail('Set FORGE_CAPTURE_ALLOWED_LOGINS to explicit consenting GitHub logins, or empty to deny all; no wildcard.');
  if (vars.FORGE_SEMANTIC_LEASE_SECONDS !== undefined) fail('Remove FORGE_SEMANTIC_LEASE_SECONDS; quarantine is fixed by runtime.');
  if (vars.FORGE_ENVIRONMENT !== (local ? 'local' : 'production')) fail('Set FORGE_ENVIRONMENT for this check mode.');
  if (typeof vars.GITHUB_APP_CLIENT_ID !== 'string' || !vars.GITHUB_APP_CLIENT_ID || /\s/.test(vars.GITHUB_APP_CLIENT_ID)) fail('Set your GitHub App client ID without whitespace.');
  if (typeof vars.GITHUB_APP_SLUG !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(vars.GITHUB_APP_SLUG)) fail('Set your GitHub App slug.');
  const hosts = vars.FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS?.split(',') ?? [];
  if (!hosts.length || hosts.some(host => !/^(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)*)$/.test(host.trim()))) fail('Set explicit OAuth redirect hosts, without schemes, paths or wildcards.');
  for (const name of ['FORGE_CAPTURE_DAILY_LIMIT', 'FORGE_SEMANTIC_DAILY_CALL_LIMIT', 'FORGE_SEMANTIC_MAX_CONCURRENCY']) if (!positiveInteger(vars[name])) fail(`Set ${name} to a positive integer string.`);
  if (Number(vars.FORGE_SEMANTIC_DAILY_CALL_LIMIT) > 100_000 || Number(vars.FORGE_SEMANTIC_MAX_CONCURRENCY) > 64) fail('Semantic limits exceed runtime ceilings: 100000 daily calls and 64 concurrent calls.');
  if (!['allow', 'deny'].includes(vars.FORGE_JEV_PRIVATE_SOURCE)) fail('Set an explicit private-source policy: allow or deny.');
  try {
    const route = new URL(vars.TYPESAFE_BASE_URL);
    if (route.origin !== 'https://api.cloudflare.com' || !/^\/client\/v4\/accounts\/[0-9a-f]{32}\/ai\/run$/.test(route.pathname) || route.search || route.hash || route.username || route.password) throw new Error();
  } catch { fail('Set the single Cloudflare JEV route: https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/run.'); }
  try {
    const origin = new URL(vars.FORGE_PUBLIC_ORIGIN);
    if (origin.search || origin.hash || origin.username || origin.password || origin.href.replace(/\/$/, '') !== vars.FORGE_PUBLIC_ORIGIN) throw new Error();
    if (local) {
      if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname)) throw new Error();
    } else {
      if (origin.protocol !== 'https:' || origin.hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(origin.hostname)) throw new Error();
      const routes = config.routes ?? [];
      if (!Array.isArray(routes)) throw new Error();
      if (origin.hostname.endsWith('.workers.dev')) {
        if (!origin.hostname.startsWith(`${config.name}.`) || origin.pathname !== '/' || config.workers_dev !== true || routes.length) throw new Error();
      } else {
        const custom = routes.some(route => route.pattern === origin.hostname && route.custom_domain === true);
        const mount = origin.pathname.replace(/\/$/, '');
        const pathRoute = routes.some(route => route.pattern === `${origin.hostname}${mount}*` && route.zone_name && (origin.hostname === route.zone_name || origin.hostname.endsWith(`.${route.zone_name}`)));
        const discovery = ['oauth-protected-resource', 'oauth-authorization-server'].every(kind => routes.some(route => route.pattern === `${origin.hostname}/.well-known/${kind}/*` && route.zone_name && (origin.hostname === route.zone_name || origin.hostname.endsWith(`.${route.zone_name}`))));
        if (!(custom || (pathRoute && (!mount || discovery)))) throw new Error();
      }
    }
  } catch { fail('FORGE_PUBLIC_ORIGIN must match your Worker URL and routes, including OAuth discovery routes for a path mount.'); }
  const databases = config.d1_databases;
  if (!Array.isArray(databases) || databases.length !== 1 || databases[0]?.binding !== 'METADATA' || !/^[a-z0-9][a-z0-9_-]*$/i.test(databases[0]?.database_name ?? '') || !uuid.test(databases[0]?.database_id ?? '') || databases[0]?.migrations_dir !== 'migrations') fail('Set one own METADATA D1 database with its UUID and migrations directory.');
  const bindings = config.durable_objects?.bindings;
  if (!Array.isArray(bindings) || bindings.length !== 1 || bindings[0]?.name !== 'MCP_SESSIONS' || bindings[0]?.class_name !== 'ForgeMcpSession' || bindings[0]?.script_name) fail('Keep the local MCP_SESSIONS / ForgeMcpSession Durable Object binding.');
  if (!Array.isArray(config.migrations) || !config.migrations.some(migration => migration.tag && migration.new_sqlite_classes?.includes('ForgeMcpSession'))) fail('Keep the ForgeMcpSession SQLite Durable Object migration.');
  for (const name of [...requiredSecrets, 'GITHUB_APP_PRIVATE_KEY', 'FORGE_DEV_AUTH_TOKEN']) if (Object.hasOwn(vars, name)) fail(`Remove ${name} from public vars; credentials belong in secrets.`);
  if (Object.hasOwn(secrets, 'GITHUB_APP_PRIVATE_KEY')) fail('Remove the unused GitHub App private key from setup.');
  if (!configOnly) {
    for (const name of [...requiredSecrets, ...(local ? ['FORGE_DEV_AUTH_TOKEN'] : [])]) {
      const value = secrets[name];
      if (typeof value !== 'string' || !value.trim() || placeholder.test(value)) fail(`Missing or placeholder credential: ${name}.`);
    }
    if (secrets.FORGE_SIGNING_KEY && Buffer.byteLength(secrets.FORGE_SIGNING_KEY) < 32) fail('FORGE_SIGNING_KEY must contain at least 32 bytes; generate it randomly.');
  }
  return errors;
}

function main(args) {
  const options = { configOnly: false, local: false };
  let configPath;
  let secretsPath;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) configPath = args[++i];
    else if (args[i] === '--secrets-file' && args[i + 1]) secretsPath = args[++i];
    else if (args[i] === '--config-only') options.configOnly = true;
    else if (args[i] === '--local') options.local = true;
    else throw new Error('Usage: node scripts/check-config.mjs --config FILE [--secrets-file FILE] [--config-only] [--local]');
  }
  if (!configPath) throw new Error('Pass --config explicitly; this checker never selects the maintainer config.');
  let config;
  try { config = parseConfig(fs.readFileSync(configPath, 'utf8')); } catch { throw new Error('Cannot read or parse config JSONC.'); }
  let secrets = process.env;
  if (secretsPath) {
    try { secrets = parseSecrets(fs.readFileSync(secretsPath, 'utf8')); } catch { throw new Error('Cannot read or parse secrets file. Values are never printed.'); }
  }
  const errors = checkConfig(config, { ...options, secrets });
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else console.log(options.configOnly ? 'Config checks passed; credentials were not checked.' : 'Local config and credential-presence checks passed. No provider access, deployment or live verification was performed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
