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
  FORGE_DEV_AUTH_TOKEN?: string;
  FORGE_OWNER_AUTH_TOKEN?: string;
  FORGE_CAPABILITY_SIGNING_KEY: string;
  FORGE_INTERNAL_PREVIEW_KEY: string;
  FORGE_DEFAULT_TENANT_ID: string;
  FORGE_DEFAULT_PROJECT_ID: string;
  FORGE_PUBLIC_ORIGIN: string;
  FORGE_PREVIEW_HOSTNAME: string;
  // Minutes a workspace may hold a slot without activity before the lazy reaper
  // reclaims it. Optional; defaults to 30 when unset or invalid.
  FORGE_SLOT_TTL_MINUTES?: string;
  // Concurrency caps. FORGE_MAX_WORKSPACES bounds the global total (keep in step
  // with the container max_instances); FORGE_MAX_WORKSPACES_PER_TENANT bounds a
  // single account. Optional; default 8 each.
  FORGE_MAX_WORKSPACES?: string;
  FORGE_MAX_WORKSPACES_PER_TENANT?: string;
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
