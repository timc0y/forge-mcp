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
  /**
   * Rendered captures only. Kept because MCP clients disagree about whether
   * they render inline images, so a hosted copy is the half of the evidence
   * that works everywhere — and the half a human can still open tomorrow.
   */
  ARTIFACTS: R2Bucket;
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
  /** Development only. Bypasses OAuth with a fixed bearer token. */
  FORGE_DEV_AUTH_TOKEN?: string;
}
