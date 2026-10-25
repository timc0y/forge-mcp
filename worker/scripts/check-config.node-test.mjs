import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkConfig, parseConfig, parseSecrets } from './check-config.mjs';

const template = fs.readFileSync(new URL('../wrangler.self-host.example.jsonc', import.meta.url), 'utf8');
const ownAccount = 'a'.repeat(32);
const own = () => parseConfig(template
  .replaceAll('REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID', ownAccount)
  .replaceAll('REPLACE_WITH_JEV_CLOUDFLARE_ACCOUNT_ID', 'b'.repeat(32))
  .replaceAll('REPLACE_WITH_WORKERS_SUBDOMAIN', 'own-account')
  .replaceAll('REPLACE_WITH_GITHUB_APP_CLIENT_ID', 'Iv1ownclientid')
  .replaceAll('REPLACE_WITH_GITHUB_APP_SLUG', 'own-forge-app')
  .replaceAll('REPLACE_WITH_OWN_GITHUB_LOGIN', 'own-login')
  .replaceAll('REPLACE_WITH_OWN_D1_DATABASE_NAME', 'own-forge-db')
  .replaceAll('REPLACE_WITH_OWN_D1_DATABASE_ID', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
const secrets = {
  GITHUB_APP_CLIENT_SECRET: 'synthetic-client-credential',
  FORGE_SIGNING_KEY: 'synthetic-signing-key-with-at-least-32-bytes',
  CLOUDFLARE_API_TOKEN: 'synthetic-browser-credential',
  TYPESAFE_API_KEY: 'synthetic-jev-credential'
};

test('the copyable template refuses deployment readiness until replaced', () => {
  assert.ok(checkConfig(parseConfig(template), { secrets }).some(error => error.includes('placeholders')));
  assert.deepEqual(checkConfig(own(), { secrets }), []);
  assert.throws(() => parseConfig('{"secret": "unterminated}'), /JSONC object/);
});

test('accepts documented dotted and current undotted GitHub App client IDs', () => {
  for (const clientId of ['Iv1.ab1112223334445c', 'Iv23ownclientid', 'opaque-client-id']) {
    const config = own();
    config.vars.GITHUB_APP_CLIENT_ID = clientId;
    assert.deepEqual(checkConfig(config, { secrets }), []);
  }
  for (const clientId of ['', ' ', 'client id']) {
    const config = own();
    config.vars.GITHUB_APP_CLIENT_ID = clientId;
    assert.ok(checkConfig(config, { secrets }).some(error => error.includes('client ID')));
  }
});

test('Git ignores Wrangler secret file variants while allowing intentional examples', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const directory of ['', 'worker/']) {
    for (const filename of ['.env', '.env.local', '.env.production', '.env.production.local', '.dev.vars', '.dev.vars.development']) {
      const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', '--', `${directory}${filename}`], { cwd: root });
      assert.equal(result.status, 0, `${directory}${filename} must be ignored`);
    }
    for (const filename of ['.env.example', '.dev.vars.example']) {
      const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', '--', `${directory}${filename}`], { cwd: root });
      assert.equal(result.status, 1, `${directory}${filename} must remain available for sharing`);
    }
  }
});

test('rejects invalid resources, wrong bindings and unsupported semantic policy/routes', () => {
  for (const mutate of [
    config => { config.account_id = 'invalid-account-id'; },
    config => { config.vars.FORGE_UNLIMITED_LOGINS = 'someone'; },
    config => { config.vars.FORGE_CAPTURE_ALLOWED_LOGINS = '*'; },
    config => { config.vars.TYPESAFE_BASE_URL = 'https://inference.invalid/run'; },
    config => { config.vars.FORGE_JEV_PRIVATE_SOURCE = 'implicit'; },
    config => { config.vars.FORGE_SEMANTIC_MAX_CONCURRENCY = '0'; },
    config => { config.vars.FORGE_SEMANTIC_MAX_CONCURRENCY = '65'; },
    config => { config.vars.FORGE_SEMANTIC_DAILY_CALL_LIMIT = '100001'; },
    config => { config.vars.FORGE_SEMANTIC_LEASE_SECONDS = '60'; },
    config => { config.d1_databases[0].binding = 'OTHER_DB'; },
    config => { config.durable_objects.bindings[0].script_name = 'other-worker'; },
    config => { config.migrations = []; },
    config => { config.vars.FORGE_PUBLIC_ORIGIN = 'https://elsewhere.invalid/forge'; },
    config => { config.vars.GITHUB_APP_CLIENT_SECRET = 'public-secret-sentinel'; }
  ]) {
    const config = own();
    mutate(config);
    const errors = checkConfig(config, { secrets });
    assert.ok(errors.length);
    assert.ok(!errors.join().includes('public-secret-sentinel'));
  }
});

test('accepts a matching path mount only with its external OAuth discovery routes', () => {
  const config = own();
  config.vars.FORGE_PUBLIC_ORIGIN = 'https://forge.own-domain.dev/forge';
  config.routes = [{ pattern: 'forge.own-domain.dev/forge*', zone_name: 'own-domain.dev' }];
  assert.ok(checkConfig(config, { secrets }).length);
  config.routes.push(...['oauth-protected-resource', 'oauth-authorization-server'].map(kind => ({ pattern: `forge.own-domain.dev/.well-known/${kind}/*`, zone_name: 'own-domain.dev' })));
  assert.deepEqual(checkConfig(config, { secrets }), []);
});

test('requires exactly the configured Worker and one account label on workers.dev', () => {
  const config = own();
  for (const host of [`${config.name}.own-account.workers.dev`, `${config.name}.a.workers.dev`]) {
    config.vars.FORGE_PUBLIC_ORIGIN = `https://${host}`;
    assert.deepEqual(checkConfig(config, { secrets }), []);
  }
  for (const host of [
    `${config.name}.nested.invalid.workers.dev`,
    `${config.name}.workers.dev`,
    `other.own-account.workers.dev`,
    `${config.name}..workers.dev`,
    `${config.name}.-account.workers.dev`,
    `${config.name}.account-.workers.dev`,
    `${config.name}.account_name.workers.dev`,
    `${config.name}.own-account.workers.dev:8443`
  ]) {
    config.vars.FORGE_PUBLIC_ORIGIN = `https://${host}`;
    const errors = checkConfig(config, { secrets });
    assert.ok(errors.some(error => error.includes('FORGE_PUBLIC_ORIGIN')), host);
    assert.ok(Object.values(secrets).every(secret => !errors.join().includes(secret)));
  }
});

test('preserves custom domains and root or nested path mounts', () => {
  for (const mount of ['', '/forge', '/tools/forge']) {
    const config = own();
    config.vars.FORGE_PUBLIC_ORIGIN = `https://forge.own-domain.dev${mount}`;
    config.routes = mount
      ? [{ pattern: `forge.own-domain.dev${mount}*`, zone_name: 'own-domain.dev' }, ...['oauth-protected-resource', 'oauth-authorization-server'].map(kind => ({ pattern: `forge.own-domain.dev/.well-known/${kind}/*`, zone_name: 'own-domain.dev' }))]
      : [{ pattern: 'forge.own-domain.dev', custom_domain: true }];
    assert.deepEqual(checkConfig(config, { secrets }), []);
  }
  const config = own();
  config.vars.FORGE_PUBLIC_ORIGIN = 'https://forge.own-domain.dev';
  config.routes = [{ pattern: 'forge.own-domain.dev*', zone_name: 'own-domain.dev' }];
  assert.deepEqual(checkConfig(config, { secrets }), []);
});

test('credential absence and placeholders fail without echoing values', () => {
  const supplied = { ...secrets, TYPESAFE_API_KEY: 'replace-me-secret-sentinel', FORGE_SIGNING_KEY: '' };
  const errors = checkConfig(own(), { secrets: supplied });
  assert.ok(errors.some(error => error.includes('TYPESAFE_API_KEY')));
  assert.ok(errors.some(error => error.includes('FORGE_SIGNING_KEY')));
  assert.ok(!errors.join().includes(supplied.TYPESAFE_API_KEY));
  assert.deepEqual(checkConfig(own(), { configOnly: true }), []);
  assert.deepEqual(parseSecrets('A="a#b"\nB=plain # comment\nC=\'quoted\'\n'), { A: 'a#b', B: 'plain', C: 'quoted' });
});

test('local mode requires local origin and a development bearer credential', () => {
  const config = own();
  config.vars.FORGE_ENVIRONMENT = 'local';
  config.vars.FORGE_PUBLIC_ORIGIN = 'http://localhost:8787';
  assert.ok(checkConfig(config, { secrets, local: true }).some(error => error.includes('FORGE_DEV_AUTH_TOKEN')));
  assert.deepEqual(checkConfig(config, { secrets: { ...secrets, FORGE_DEV_AUTH_TOKEN: 'synthetic-local-token' }, local: true }), []);
});

test('empty capture availability is a valid deny-all choice', () => {
  const config = own();
  config.vars.FORGE_CAPTURE_ALLOWED_LOGINS = '';
  assert.deepEqual(checkConfig(config, { secrets }), []);
});

test('access requires explicit valid logins, including in local mode', () => {
  for (const value of [undefined, null, '', ' ', '*', 'own-login,', ',own-login', 'own-login, bad_login', '-own', 'own-', 'two--hyphens', 'a'.repeat(40), ['own-login']]) {
    const config = own();
    config.vars.FORGE_ALLOWED_LOGINS = value;
    assert.ok(checkConfig(config, { secrets }).some(error => error.includes('FORGE_ALLOWED_LOGINS')));
    config.vars.FORGE_ENVIRONMENT = 'local';
    config.vars.FORGE_PUBLIC_ORIGIN = 'http://localhost:8787';
    assert.ok(checkConfig(config, { secrets: { ...secrets, FORGE_DEV_AUTH_TOKEN: 'synthetic-local-token' }, local: true }).some(error => error.includes('FORGE_ALLOWED_LOGINS')));
  }
  const config = own();
  config.vars.FORGE_ALLOWED_LOGINS = ' own-login, Second-Operator ';
  assert.deepEqual(checkConfig(config, { secrets }), []);
});

test('CLI cannot implicitly select a production config', () => {
  const result = spawnSync(process.execPath, [new URL('./check-config.mjs', import.meta.url).pathname], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--config explicitly/);
});
