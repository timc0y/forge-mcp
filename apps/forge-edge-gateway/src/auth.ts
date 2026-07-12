import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ForgeError } from '@forge/core';
import type { Env } from './env';

export interface AuthenticatedContext {
  subject: string;
  tenantId: string;
  projectId: string;
  clientId: string;
  scopes: string[];
}

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function constantTimeEqual(leftValue: string, rightValue: string): boolean {
  const left = new TextEncoder().encode(leftValue);
  const right = new TextEncoder().encode(rightValue);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function bearer(request: Request): string {
  return request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
}

function required(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) {
    throw new ForgeError({
      code: 'FORGE_INTERNAL_ERROR',
      message: `Forge OAuth is not configured: ${name}.`,
      retryable: false
    });
  }
  return result;
}

function getJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  let value = jwks.get(url);
  if (!value) {
    value = createRemoteJWKSet(new URL(url));
    jwks.set(url, value);
  }
  return value;
}

export async function authenticate(request: Request, env: Env): Promise<AuthenticatedContext> {
  const token = bearer(request);
  if (!token) {
    throw new ForgeError({
      code: 'FORGE_AUTH_REQUIRED',
      message: 'Forge authentication is required.',
      retryable: false
    });
  }

  if (env.FORGE_ENVIRONMENT === 'local' || env.FORGE_ENVIRONMENT === 'development') {
    if (env.FORGE_DEV_AUTH_TOKEN && constantTimeEqual(token, env.FORGE_DEV_AUTH_TOKEN)) {
      return {
        subject: 'dev-user',
        tenantId: env.FORGE_DEFAULT_TENANT_ID,
        projectId: env.FORGE_DEFAULT_PROJECT_ID,
        clientId: request.headers.get('mcp-session-id') ?? 'direct',
        scopes: ['forge:workspace']
      };
    }
  }

  try {
    const issuer = required(env.FORGE_OAUTH_ISSUER, 'FORGE_OAUTH_ISSUER');
    const audience = required(env.FORGE_OAUTH_AUDIENCE, 'FORGE_OAUTH_AUDIENCE');
    const jwksUrl = required(env.FORGE_OAUTH_JWKS_URL, 'FORGE_OAUTH_JWKS_URL');
    const { payload } = await jwtVerify(token, getJwks(jwksUrl), { issuer, audience });
    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    const tenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id : '';
    const projectId = typeof payload.project_id === 'string' ? payload.project_id : '';
    const scopeValue = typeof payload.scope === 'string' ? payload.scope : '';
    const scopes = scopeValue.split(/\s+/).filter(Boolean);
    if (!subject || !tenantId || !projectId || !scopes.includes('forge:workspace')) {
      throw new Error('Required subject, tenant, project, or scope claim is missing.');
    }
    return {
      subject,
      tenantId,
      projectId,
      clientId: typeof payload.client_id === 'string' ? payload.client_id : 'unknown',
      scopes
    };
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError({
      code: 'FORGE_AUTH_REQUIRED',
      message: 'Forge access token is invalid or outside its scope.',
      retryable: false
    });
  }
}

export function oauthChallenge(env: Env): string {
  return `Bearer resource_metadata="${env.FORGE_PUBLIC_ORIGIN}/.well-known/oauth-protected-resource", scope="forge:workspace"`;
}
