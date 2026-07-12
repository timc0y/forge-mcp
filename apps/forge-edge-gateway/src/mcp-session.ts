import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import {
  ForgeError,
  ids,
  workspaceIdFromIdempotency,
  type ProcessId,
  type ProjectId,
  type TenantId,
  type WorkspaceId
} from '@forge/core';
import { issueCapability } from '@forge/capabilities';
import { registerForgeToolsV1 } from '@forge/mcp-adapter-v1';
import type { ForgeToolHandlers } from '@forge/mcp-core';
import { R2ArtifactStore } from '@forge/artifacts-r2';
import { CloudflareBrowserProvider } from '@forge/browser-cloudflare';
import { workflowInstanceId } from '@forge/workflows-cloudflare';
import type { Env } from './env';
import type { WorkspaceCoordinator } from './workspace-coordinator';

interface SessionProps extends Record<string, unknown> {
  subject: string;
  tenantId: string;
  projectId: string;
  clientId: string;
}

function coordinator(env: Env, workspaceId: string): DurableObjectStub<WorkspaceCoordinator> {
  return env.WORKSPACE_COORDINATORS.get(env.WORKSPACE_COORDINATORS.idFromName(workspaceId));
}

function text(value: unknown): string {
  return String(value);
}

function number(value: unknown): number {
  return Number(value);
}

function optionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function asRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

export class ForgeMcpSession extends McpAgent<Env, unknown, SessionProps> {
  server = new McpServer({ name: 'Forge MCP', version: '0.1.0' });

  async init(): Promise<void> {
    registerForgeToolsV1(this.server, this.handlers());
  }

  private identity(): SessionProps {
    if (this.props?.subject && this.props.tenantId && this.props.projectId) return this.props;
    if (this.env.FORGE_ENVIRONMENT === 'local' || this.env.FORGE_ENVIRONMENT === 'development') {
      return {
        subject: 'dev-user',
        tenantId: this.env.FORGE_DEFAULT_TENANT_ID,
        projectId: this.env.FORGE_DEFAULT_PROJECT_ID,
        clientId: 'development'
      };
    }
    throw new ForgeError({
      code: 'FORGE_AUTH_REQUIRED',
      message: 'Authenticated MCP session context is missing.',
      retryable: false
    });
  }

  private handlers(): ForgeToolHandlers {
    const env = this.env;
    return {
      forge_workspace_create: async (input) => {
        const identity = this.identity();
        const idempotencyKey = text(input.idempotency_key);
        const workspaceId = await workspaceIdFromIdempotency(
          `${identity.tenantId}:${identity.projectId}`,
          idempotencyKey
        );
        const result = await coordinator(env, workspaceId).initialize({
          workspaceId,
          tenantId: identity.tenantId as TenantId,
          projectId: identity.projectId as ProjectId,
          repository: input.repository as {
            provider: 'github';
            owner: string;
            name: string;
          },
          ref: text(input.ref),
          runtimeProfile: text(input.runtime) as
            | 'node-22'
            | 'node-24'
            | 'python-3.13'
            | 'general-purpose',
          persistence: text(input.persistence) as
            | 'ephemeral'
            | 'snapshot_on_idle'
            | 'persistent',
          bootstrap: Boolean(input.bootstrap),
          idempotencyKey,
          actor: { type: 'agent', id: identity.subject }
        });
        if (!result.replay || result.state === 'requested' || result.state === 'failed') {
          const workflowId = workflowInstanceId('provision', workspaceId);
          try {
            await env.PROVISION_WORKFLOW.create({
              id: workflowId,
              params: { workspaceId, bootstrap: Boolean(input.bootstrap) }
            });
          } catch {
            await env.PROVISION_WORKFLOW.get(workflowId);
          }
        }
        return {
          workspace_id: workspaceId,
          state: result.state,
          operation_id: result.operationId,
          workspace_revision: result.revision
        };
      },
      forge_workspace_get: async (input) =>
        asRecord(await coordinator(env, text(input.workspace_id)).getState()),
      forge_files_tree: async (input) =>
        asRecord(await coordinator(env, text(input.workspace_id)).filesTree({
          path: text(input.path),
          depth: number(input.depth),
          limit: number(input.limit)
        })),
      forge_files_read: async (input) =>
        asRecord(await coordinator(env, text(input.workspace_id)).filesRead({
          path: text(input.path),
          startLine: optionalNumber(input.start_line),
          endLine: optionalNumber(input.end_line),
          maxBytes: number(input.max_bytes)
        })),
      forge_files_patch: async (input) =>
        asRecord(await coordinator(env, text(input.workspace_id)).filesPatch({
          patch: text(input.patch),
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: text(input.idempotency_key)
        })),
      forge_shell_exec: async (input) =>
        asRecord(await coordinator(env, text(input.workspace_id)).shellExec({
          command: text(input.command),
          cwd: text(input.cwd),
          timeoutMs: number(input.timeout_ms),
          environment: input.environment as Record<string, string>,
          networkPolicy: text(input.network_policy) as never,
          outputLimitBytes: number(input.output_limit_bytes),
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: text(input.idempotency_key),
          approved: Boolean(input.approved)
        })),
      forge_process_start: async (input) =>
        asRecord(await coordinator(env, text(input.workspace_id)).processStart({
          command: text(input.command),
          cwd: text(input.cwd),
          environment: input.environment as Record<string, string>,
          networkPolicy: text(input.network_policy) as never,
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: text(input.idempotency_key)
        })),
      forge_process_logs: async (input) =>
        asRecord(await coordinator(env, text(input.workspace_id)).processLogs({
          processId: text(input.process_id) as ProcessId,
          cursor: input.cursor ? text(input.cursor) : undefined
        })),
      forge_git_status: async (input) =>
        asRecord(await coordinator(env, text(input.workspace_id)).gitStatus()),
      forge_git_diff: async (input) =>
        asRecord(await coordinator(env, text(input.workspace_id)).gitDiff({
          staged: Boolean(input.staged)
        })),
      forge_preview_expose: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id) as WorkspaceId;
        const value = await coordinator(env, workspaceId).previewExpose({
          processId: text(input.process_id) as ProcessId,
          port: number(input.port),
          hostname: env.FORGE_PREVIEW_HOSTNAME,
          access: text(input.access) as never,
          ttlSeconds: number(input.ttl_seconds),
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: text(input.idempotency_key)
        });
        if ('replay' in value) return asRecord(value);
        const now = Math.floor(Date.now() / 1000);
        const capability = await issueCapability(
          {
            version: 1,
            subject: identity.subject,
            tenantId: identity.tenantId,
            workspaceId,
            action: `preview:${value.previewId}`,
            nonce: crypto.randomUUID(),
            issuedAt: now,
            expiresAt: Math.floor(new Date(value.expiresAt).getTime() / 1000)
          },
          env.FORGE_CAPABILITY_SIGNING_KEY
        );
        return {
          ...value,
          preview_url: `${env.FORGE_PUBLIC_ORIGIN}/preview/${workspaceId}/${value.previewId}/`,
          preview_capability: capability,
          preview_capability_header: 'x-forge-preview-capability'
        };
      },
      forge_browser_screenshot: async (input) => {
        const workspaceId = text(input.workspace_id) as WorkspaceId;
        const previewId = text(input.preview_id);
        const detail = await coordinator(env, workspaceId).getPreviewInternal(previewId);
        if (new Date(detail.preview.expiresAt).getTime() <= Date.now()) {
          throw new ForgeError({
            code: 'FORGE_PREVIEW_UNAVAILABLE',
            message: 'Preview has expired.',
            retryable: false
          });
        }
        const artifacts = new R2ArtifactStore(env.ARTIFACTS);
        const browser = new CloudflareBrowserProvider(env.BROWSER, artifacts, detail.workspace.tenantId);
        const result = await browser.screenshot({
          workspaceId,
          url: `${env.FORGE_PUBLIC_ORIGIN}/preview/${workspaceId}/${previewId}/`,
          path: text(input.path),
          headers: { 'x-forge-internal-preview': env.FORGE_INTERNAL_PREVIEW_KEY },
          viewport: input.viewport as { width: number; height: number },
          fullPage: Boolean(input.full_page),
          operationId: ids.operation(),
          repositoryCommit: detail.workspace.currentCommit,
          workspaceRevision: detail.workspace.revision
        });
        return asRecord(result);
      },
      forge_workspace_destroy: async (input) => {
        const workspaceId = text(input.workspace_id) as WorkspaceId;
        const idempotencyKey = text(input.idempotency_key);
        const request = await coordinator(env, workspaceId).requestDestroy({
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey
        });
        if (request.state !== 'destroyed') {
          const workflowId = workflowInstanceId('destroy', workspaceId);
          try {
            await env.DESTROY_WORKFLOW.create({
              id: workflowId,
              params: {
                workspaceId,
                idempotencyKey,
                preserveArtifacts: Boolean(input.preserve_artifacts)
              }
            });
          } catch {
            await env.DESTROY_WORKFLOW.get(workflowId);
          }
        }
        return {
          workspace_id: workspaceId,
          state: request.state,
          operation_id: request.operationId,
          workspace_revision: request.workspaceRevision,
          replay: request.replay
        };
      }
    };
  }
}
