/**
 * Who is calling, and nothing else.
 *
 * There is exactly one kind of identity in Forge: a GitHub account with the
 * Forge App installed on it. So there is one token format, one issuer, and one
 * function that turns a bearer string into a user. The external-issuer path,
 * the JWKS cache, the scope lists and the capability tokens that used to live
 * alongside this all described permissions this system does not have — a token
 * here either speaks for a user or it does not.
 *
 * The token is deliberately not a JWT. A JWT's header is an instruction to the
 * verifier about how to verify it, which is a decision this file has already
 * made: HMAC-SHA256, this key, no alternatives. What remains is a payload and
 * a signature over it.
 */
import type { Identity } from './contracts';
import type { Env } from './env';
import { ForgeError } from './errors';

/**
 * Domain separation. `FORGE_SIGNING_KEY` also signs approval links. Access
 * tokens carry this context so an approval signature can never be presented as
 * an access token. Refresh tokens are separate opaque, rotating credentials.
 */
const TOKEN_CONTEXT = 'forge.access.v1';
/** Sliding inactivity window for a client connection. */
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Two claims. Anything else here would be a copy of a column this request is
 * about to read anyway, and a copy is a thing that can go stale while the
 * token stays valid — a login that changed, an installation that was removed.
 * `sub` is authoritative for one thing only: which row to load.
 */
interface Claims {
  sub: string;
  exp: number;
}

interface RefreshTokenRow {
  family_id: string;
  user_id: string;
  client_id: string;
  key_tag: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

interface UserRow {
  id: string;
  github_login: string;
  installation_id: string | null;
}

export async function issueToken(env: Env, userId: string, ttlSeconds: number): Promise<string> {
  const claims: Claims = { sub: userId, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  return `${payload}.${await sign(env, TOKEN_CONTEXT, payload)}`;
}

export async function issueRefreshToken(
  env: Env,
  userId: string,
  clientId: string,
  familyId: string = crypto.randomUUID()
): Promise<string> {
  const token = `fr_${encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const now = new Date();
  await env.METADATA.prepare(
    `INSERT INTO oauth_refresh_tokens
       (token_hash, family_id, user_id, client_id, key_tag, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  )
    .bind(
      await sha256(token),
      familyId,
      userId,
      clientId,
      await signingKeyTag(env),
      new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
      now.toISOString()
    )
    .run();
  return token;
}

/**
 * Spend one refresh token exactly once and replace it with another in the same
 * family. Reusing a spent/revoked token revokes the remaining family, which
 * turns a stolen-token race into a reconnect instead of a persistent fork.
 */
export async function rotateRefreshToken(
  env: Env,
  token: string,
  clientId: string
): Promise<{ userId: string; refreshToken: string } | null> {
  if (!token.startsWith('fr_')) return null;
  const hash = await sha256(token);
  const row = await env.METADATA.prepare(
    `SELECT r.family_id, r.user_id, r.client_id, r.key_tag, r.expires_at, r.used_at, r.revoked_at
       FROM oauth_refresh_tokens r
       JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = ?1`
  )
    .bind(hash)
    .first<RefreshTokenRow>();
  if (!row || row.client_id !== clientId) return null;
  if (row.key_tag !== (await signingKeyTag(env))) {
    await revokeRefreshFamily(env, row.family_id);
    return null;
  }

  const expires = Date.parse(row.expires_at);
  if (!Number.isFinite(expires) || expires <= Date.now()) {
    await revokeRefreshFamily(env, row.family_id);
    return null;
  }
  if (row.used_at || row.revoked_at) {
    await revokeRefreshFamily(env, row.family_id);
    return null;
  }

  const spent = await env.METADATA.prepare(
    `UPDATE oauth_refresh_tokens
        SET used_at = ?1
      WHERE token_hash = ?2 AND used_at IS NULL AND revoked_at IS NULL`
  )
    .bind(new Date().toISOString(), hash)
    .run();
  if ((spent.meta.changes ?? 0) !== 1) {
    await revokeRefreshFamily(env, row.family_id);
    return null;
  }

  return {
    userId: row.user_id,
    refreshToken: await issueRefreshToken(env, row.user_id, row.client_id, row.family_id)
  };
}

async function revokeRefreshFamily(env: Env, familyId: string): Promise<void> {
  await env.METADATA.prepare(
    `UPDATE oauth_refresh_tokens
        SET revoked_at = ?1
      WHERE family_id = ?2 AND revoked_at IS NULL`
  )
    .bind(new Date().toISOString(), familyId)
    .run();
}

export async function authenticate(env: Env, request: Request): Promise<Identity> {
  const token = bearer(request);
  if (!token) {
    throw authRequired(
      'Forge needs an access token. Connect the Forge MCP server in your client and authorize it, then try again.'
    );
  }

  if (devTokenAccepted(env, token)) return identityOf(env, await seededUser(env));

  const userId = await verify(env, token);
  if (!userId) {
    throw authRequired(
      'This Forge access token is not valid, or it has expired. Authorize Forge again from your client.'
    );
  }

  const row = await env.METADATA.prepare(
    'SELECT id, github_login, installation_id FROM users WHERE id = ?1'
  )
    .bind(userId)
    .first<UserRow>();

  return identityOf(env, row);
}

/**
 * Deleting the user row is the revocation mechanism, and this lookup is what
 * makes it immediate: every request re-reads the row, so a removed user's
 * outstanding tokens stop working on their next call rather than at expiry.
 */
function identityOf(env: Env, row: UserRow | null): Identity {
  if (!row) {
    throw authRequired(
      'Forge has no account for this access token. Authorize Forge again from your client.'
    );
  }

  if (!row.installation_id) {
    // The one error in this file that a user can act on without a client, so
    // it carries the exact URL rather than describing the destination. An
    // error that names the fix is worth more than an error that is correct.
    const url = installUrl(env);
    throw new ForgeError({
      code: 'FORGE_AUTH_REQUIRED',
      message:
        `Forge is connected to GitHub as ${row.github_login}, but the Forge GitHub App is not ` +
        `installed on any of that account's repositories yet. Install it at ${url}, choose the ` +
        'repositories Forge may work on, then try again.',
      details: { installUrl: url, githubLogin: row.github_login }
    });
  }

  return {
    userId: row.id,
    githubLogin: row.github_login,
    installationId: row.installation_id
  };
}

function installUrl(env: Env): string {
  return `https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new`;
}

function authRequired(message: string): ForgeError {
  return new ForgeError({ code: 'FORGE_AUTH_REQUIRED', message });
}

// ---------------------------------------------------------------------------
// Development
// ---------------------------------------------------------------------------

/**
 * The environment test comes first and is checked against the union in `Env`,
 * so a production deployment that still has `FORGE_DEV_AUTH_TOKEN` set — the
 * likely accident — cannot reach the comparison at all.
 */
function devTokenAccepted(env: Env, token: string): boolean {
  if (env.FORGE_ENVIRONMENT !== 'local' && env.FORGE_ENVIRONMENT !== 'development') return false;
  const expected = env.FORGE_DEV_AUTH_TOKEN;
  return typeof expected === 'string' && expected.length > 0 && constantTimeEqual(token, expected);
}

/**
 * Development has one user, so "the seeded user" is the oldest row. If it were
 * ever ambiguous the dev token would be authenticating as whoever signed up
 * first, which is why this is fenced behind the environment check above.
 */
async function seededUser(env: Env): Promise<UserRow> {
  const row = await env.METADATA.prepare(
    'SELECT id, github_login, installation_id FROM users ORDER BY created_at ASC, id ASC LIMIT 1'
  ).first<UserRow>();

  if (!row) {
    throw authRequired(
      'The development auth token was accepted, but no user exists yet. Complete the GitHub ' +
        'authorization once so a user row exists, then this token will resolve to it.'
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

async function verify(env: Env, token: string): Promise<string | null> {
  const claims = await verifiedPayload(env, token, TOKEN_CONTEXT);
  if (!claims || typeof claims.sub !== 'string' || !claims.sub) return null;
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null;
  if (claims.exp * 1000 <= Date.now()) return null;
  return claims.sub;
}

async function verifiedPayload(
  env: Env,
  token: string,
  context: string
): Promise<Record<string, unknown> | null> {
  const separator = token.indexOf('.');
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  // Signature before parse, always: nothing downstream should ever see bytes
  // an attacker chose. The context also prevents an access token being used
  // as a refresh token, or the reverse.
  if (!constantTimeEqual(signature, await sign(env, context, payload))) return null;

  return decodePayload(payload);
}

async function sha256(value: string): Promise<string> {
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  );
}

async function signingKeyTag(env: Env): Promise<string> {
  // Non-secret fingerprint: rotating the signing key invalidates refresh-token
  // families as well as access/approval/capture tokens and stored credentials.
  return (await sha256(`forge.refresh.key:${env.FORGE_SIGNING_KEY}`)).slice(0, 22);
}

async function sign(env: Env, context: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.FORGE_SIGNING_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${context}.${payload}`)
  );
  return encodeBase64Url(new Uint8Array(signature));
}

function decodePayload(payload: string): Record<string, unknown> | null {
  let text: string;
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    text = new TextDecoder().decode(
      Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
    );
  } catch {
    return null;
  }

  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    return record;
  } catch {
    return null;
  }
}

function bearer(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? '';
}

/**
 * Compare without leaking where the mismatch is. A byte-at-a-time early return
 * turns one 32-byte secret into 32 independent one-byte guesses. Length is not
 * secret — every token of a given kind is the same length — so returning early
 * on a length mismatch reveals nothing an attacker cannot already measure.
 */
function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index] ?? 0);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
