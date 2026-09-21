import type { ForgeMcpSession } from './mcp';

/**
 * Everything Forge needs at runtime.
 *
 * No Workers AI, no container, no workflow binding. Capture uses the Browser
 * Rendering REST API rather than the `BROWSER` binding, because Quick Actions
 * are billed on browser hours only while binding-driven sessions are also
 * billed per concurrent browser.
 */
export interface Env {
  METADATA: D1Database;
  MCP_SESSIONS: DurableObjectNamespace<ForgeMcpSession>;

  FORGE_ENVIRONMENT: 'production' | 'development' | 'local';
  FORGE_PUBLIC_ORIGIN: string;
  /** Comma-separated hosts permitted as OAuth redirect targets. */
  FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS: string;

  GITHUB_APP_ID: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_CLIENT_SECRET: string;

  /** Signs approval and session tokens. At least 32 random bytes. */
  FORGE_SIGNING_KEY: string;

  CLOUDFLARE_ACCOUNT_ID: string;
  /** Scoped to Browser Rendering. Never reaches a tool result. */
  CLOUDFLARE_API_TOKEN: string;

  /** Captures allowed per user per UTC day. Absent means the default in quota.ts. */
  FORGE_CAPTURE_DAILY_LIMIT?: string;
  /**
   * GitHub logins exempt from the daily limits, comma separated.
   *
   * The preview is open to anyone, and the limit exists so that "open" cannot
   * become expensive. This is the operator's own escape hatch, not a tier —
   * there is no way for a user to be granted it from inside the product.
   */
  FORGE_UNLIMITED_LOGINS?: string;

  /** TypeSafe Jev API key for token-safe repo triage and excerpt search. */
  TYPESAFE_API_KEY?: string;
  TYPESAFE_BASE_URL?: string;

  /** Hosted inference is a separate processing boundary. Default: private source is not sent. */
  FORGE_JEV_PRIVATE_SOURCE?: 'allow' | 'deny';
  /** Development only. Bypasses OAuth with a fixed bearer token. */
  FORGE_DEV_AUTH_TOKEN?: string;
}
