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
  BACKUP_BUCKET: R2Bucket;
  BROWSER: BrowserRun;
  FORGE_DEV_AUTH_TOKEN?: string;
  FORGE_OWNER_AUTH_TOKEN?: string;
  FORGE_CAPABILITY_SIGNING_KEY: string;
  FORGE_CREDENTIAL_ENCRYPTION_KEY: string;
  FORGE_INTERNAL_PREVIEW_KEY: string;
  BACKUP_BUCKET_NAME: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  FORGE_DEFAULT_TENANT_ID: string;
  FORGE_DEFAULT_PROJECT_ID: string;
  FORGE_PUBLIC_ORIGIN: string;
  FORGE_PREVIEW_HOSTNAME: string;
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
