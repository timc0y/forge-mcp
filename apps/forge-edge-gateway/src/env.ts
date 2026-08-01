import type { Sandbox } from '@cloudflare/sandbox';
import type {
  DestroyWorkspaceParams,
  ProvisionWorkspaceParams
} from '@forge/workflows-cloudflare';
import type { ForgeMcpSession } from './mcp-session';
import type { WorkspaceCoordinator } from './workspace-coordinator';

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  MCP_SESSIONS: DurableObjectNamespace<ForgeMcpSession>;
  WORKSPACE_COORDINATORS: DurableObjectNamespace<WorkspaceCoordinator>;
  PROVISION_WORKFLOW: Workflow<ProvisionWorkspaceParams>;
  DESTROY_WORKFLOW: Workflow<DestroyWorkspaceParams>;
  METADATA: D1Database;
  ARTIFACTS: R2Bucket;
  BROWSER: BrowserRun;
  // Cloudflare Workers AI binding. Powers best-effort commit-message and PR
  // summarisation; every call has a deterministic fallback so AI is never on
  // the critical path.
  AI: Ai;
  // Kill switch for the Workers AI features. AI is ON unless this is 'true'/'1'.
  FORGE_AI_DISABLED?: string;
  FORGE_DEV_AUTH_TOKEN?: string;
  FORGE_OWNER_AUTH_TOKEN?: string;
  FORGE_CAPABILITY_SIGNING_KEY: string;
  FORGE_CREDENTIAL_ENCRYPTION_KEY: string;
  // Distinct secret for OAuth session (access/refresh) JWTs. When unset, signing
  // and verification fall back to FORGE_CAPABILITY_SIGNING_KEY. Set it via
  // `wrangler secret put FORGE_SESSION_SIGNING_KEY` to split the two key roles.
  FORGE_SESSION_SIGNING_KEY?: string;
  FORGE_INTERNAL_PREVIEW_KEY: string;
  FORGE_DEFAULT_TENANT_ID: string;
  FORGE_DEFAULT_PROJECT_ID: string;
  FORGE_PUBLIC_ORIGIN: string;
  FORGE_PREVIEW_HOSTNAME: string;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  // Minutes a workspace may hold a slot without activity before the lazy reaper
  // reclaims it. Optional; defaults to 240 when unset or invalid.
  FORGE_SLOT_TTL_MINUTES?: string;
  // Concurrency caps. FORGE_MAX_WORKSPACES bounds the global total (keep in step
  // with the container max_instances); FORGE_MAX_WORKSPACES_PER_TENANT bounds a
  // single account. Optional; defaults to 8 global and 5 per tenant.
  FORGE_MAX_WORKSPACES?: string;
  FORGE_MAX_WORKSPACES_PER_TENANT?: string;
  // How long an approval (push / PR / gated shell) stays valid. Optional; default
  // 60 minutes — long enough to survive an install+build before using it.
  FORGE_APPROVAL_TTL_MINUTES?: string;
  // Operator policy: auto-approve in-workspace shell commands that would
  // otherwise need a human click (dependency installs and other gated shell).
  // GitHub writes remain independently gated. Optional; the
  // gate stays on unless this is 'true'/'1'.
  FORGE_AUTO_APPROVE_SHELL?: string;
  /** Comma-separated CommandClass list the auto-approve flag may cover. */
  FORGE_AUTO_APPROVE_SHELL_CLASSES?: string;
  // Self-hosted machine (e.g. a Mac mini running the Forge Node Agent). The
  // sandbox/workspace self-host provider has been removed — Cloudflare is now
  // the only sandbox backend — but these still gate self-hosted browser
  // capture (see browser-router.ts). All optional — unset means Browser Run.
  FORGE_SELFHOST_ENABLED?: string;
  FORGE_SELFHOST_URL?: string;
  FORGE_SELFHOST_TOKEN?: string;
  FORGE_ENVIRONMENT:
    | 'local'
    | 'development'
    | 'preview'
    | 'staging'
    | 'production';
  FORGE_OAUTH_ISSUER?: string;
  FORGE_OAUTH_AUDIENCE?: string;
  FORGE_OAUTH_JWKS_URL?: string;
  FORGE_OAUTH_AUTHORIZATION_SERVER?: string;
  FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}
