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
import { forgeToolResponse, type ForgeToolHandlers } from '@forge/mcp-core';
import { R2ArtifactStore } from '@forge/artifacts-r2';
import { CloudflareBrowserProvider } from '@forge/browser-cloudflare';
import { workflowInstanceId } from '@forge/workflows-cloudflare';
import type { Env } from './env';
import { registerForgeConsole } from './forge-console';
import type { WorkspaceCoordinator } from './workspace-coordinator';
import {
  authorizeRepository,
  completeApproval,
  createDraftPullRequest,
  listAuthorizedRepositories,
  requestApproval,
  requireApproval
} from './github';

interface SessionProps extends Record<string, unknown> {
  subject: string;
  tenantId: string;
  projectId: string;
  clientId: string;
}

function coordinator(env: Env, workspaceId: string): DurableObjectStub<WorkspaceCoordinator> {
  return env.WORKSPACE_COORDINATORS.get(env.WORKSPACE_COORDINATORS.idFromName(workspaceId));
}

async function authorizedCoordinator(
  env: Env,
  identity: SessionProps,
  workspaceId: string
): Promise<DurableObjectStub<WorkspaceCoordinator>> {
  const value = coordinator(env, workspaceId);
  const state = await value.getState();
  if (state.tenantId !== identity.tenantId || state.projectId !== identity.projectId) {
    throw new ForgeError({
      code: 'FORGE_PERMISSION_DENIED',
      message: 'The workspace is outside the authenticated project.',
      retryable: false
    });
  }
  return value;
}

function base64(bytes: ArrayBuffer): string {
  const values = new Uint8Array(bytes);
  let binary = '';
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary);
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
  server = new McpServer(
    { name: 'Forge MCP', version: '0.1.0' },
    {
      instructions: [
        'Use Forge as a remote development computer and Parallax as the review contract.',
        'For an existing deployed URL, call forge_review first: it returns screenshots without starting a container.',
        'Create one workspace per repository task and reuse its workspace_id.',
        'Read repository instructions and parallax/ files before choosing routes or making changes.',
        'Use forge_review_capture for bounded route and viewport evidence, then call forge_artifact_get and inspect every screenshot used in a finding.',
        'Never claim a multi-step journey passed unless its interactions were executed and recorded.',
        'Inspect the diff and request explicit approval before any future Git push or pull-request action.',
        'Destroy the workspace when the review or coding task is complete.'
      ].join(' ')
    }
  );

  async init(): Promise<void> {
    registerForgeConsole(this.server);
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
      forge_repository_list: async () => {
        const identity = this.identity();
        return { repositories: await listAuthorizedRepositories(env, identity.tenantId) };
      },
      forge_review: async (input) => {
        const identity = this.identity();
        const workspaceId = ids.workspace();
        const artifacts = new R2ArtifactStore(env.ARTIFACTS);
        const browser = new CloudflareBrowserProvider(env.BROWSER, artifacts, identity.tenantId as TenantId);
        const captures = input.captures as Array<{ selection: string; path: string; state: string }>;
        const viewports = input.viewports as Array<{ id: string; width: number; height: number }>;
        const evidence: Array<Record<string, unknown>> = [];
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
        for (const capture of captures) {
          for (const viewport of viewports) {
            const result = await browser.captureEvidence({
              workspaceId,
              url: text(input.url),
              path: capture.path,
              viewport: { width: viewport.width, height: viewport.height },
              fullPage: Boolean(input.full_page),
              operationId: ids.operation(),
              workspaceRevision: 1
            });
            evidence.push({
              selection: capture.selection,
              route: capture.path,
              environment: viewport.id,
              state: capture.state,
              requestedViewport: { width: viewport.width, height: viewport.height },
              observedViewport: { width: result.screenshot.width, height: result.screenshot.height },
              screenshot: result.screenshot,
              accessibility: result.accessibility,
              inspected: false,
              limitations: ['Static screenshot evidence does not prove interactions that were not executed.']
            });
            const object = await env.ARTIFACTS.get(
              `tenant/${identity.tenantId}/workspace/${workspaceId}/artifacts/${result.screenshot.artifactId}`
            );
            if (object && object.size <= 4_000_000) {
              content.push({ type: 'image', data: base64(await object.arrayBuffer()), mimeType: 'image/png' });
            }
          }
        }
        const packet = {
          schemaVersion: 1,
          provider: 'forge',
          executionMode: 'url_review',
          containerUsed: false,
          workspaceId,
          sourceUrl: text(input.url),
          capturedAt: new Date().toISOString(),
          evidence,
          limitations: ['Static screenshot evidence does not prove interactions that were not executed.'],
          nextStep: 'Inspect every returned MCP image, then pass the evidence to Parallax with inspected set to true.'
        };
        content.unshift({ type: 'text', text: `Captured ${evidence.length} inspected screenshots without starting a container.` });
        return forgeToolResponse(packet, content);
      },
      forge_workspace_create: async (input) => {
        const identity = this.identity();
        const repository = input.repository as { provider: 'github'; owner: string; name: string };
        await authorizeRepository(env, identity, repository);
        const idempotencyKey = text(input.idempotency_key);
        const workspaceId = await workspaceIdFromIdempotency(
          `${identity.tenantId}:${identity.projectId}`,
          idempotencyKey
        );
        const active = await env.METADATA.prepare(
          `SELECT COUNT(*) AS count FROM workspaces
            WHERE id <> ?1 AND state NOT IN ('suspended', 'failed', 'destroying', 'destroyed')`
        ).bind(workspaceId).first<{ count: number }>();
        if ((active?.count ?? 0) >= 2) {
          throw new ForgeError({
            code: 'FORGE_QUOTA_EXCEEDED',
            message: 'Forge Cloud is already using both workspace slots. Finish or destroy one workspace, then retry.',
            retryable: true,
            details: { active_workspaces: active?.count ?? 0, maximum_workspaces: 2 }
          });
        }
        const result = await coordinator(env, workspaceId).initialize({
          workspaceId,
          tenantId: identity.tenantId as TenantId,
          projectId: identity.projectId as ProjectId,
          repository,
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
      forge_workspace_get: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).getState());
      },
      forge_files_tree: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).filesTree({
          path: text(input.path),
          depth: number(input.depth),
          limit: number(input.limit)
        }));
      },
      forge_files_read: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).filesRead({
          path: text(input.path),
          startLine: optionalNumber(input.start_line),
          endLine: optionalNumber(input.end_line),
          maxBytes: number(input.max_bytes)
        }));
      },
      forge_files_patch: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).filesPatch({
          patch: text(input.patch),
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: text(input.idempotency_key)
        }));
      },
      forge_shell_exec: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).shellExec({
          command: text(input.command),
          cwd: text(input.cwd),
          timeoutMs: number(input.timeout_ms),
          environment: input.environment as Record<string, string>,
          networkPolicy: text(input.network_policy) as never,
          outputLimitBytes: number(input.output_limit_bytes),
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: text(input.idempotency_key),
          approved: Boolean(input.approved)
        }));
      },
      forge_process_start: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).processStart({
          command: text(input.command),
          cwd: text(input.cwd),
          environment: input.environment as Record<string, string>,
          networkPolicy: text(input.network_policy) as never,
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: text(input.idempotency_key)
        }));
      },
      forge_process_logs: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).processLogs({
          processId: text(input.process_id) as ProcessId,
          cursor: input.cursor ? text(input.cursor) : undefined
        }));
      },
      forge_git_status: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).gitStatus());
      },
      forge_git_diff: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).gitDiff({
          staged: Boolean(input.staged)
        }));
      },
      forge_git_branch_create: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).gitBranchCreate({
          branch: text(input.branch), expectedRevision: optionalNumber(input.expected_revision), idempotencyKey: text(input.idempotency_key)
        }));
      },
      forge_git_commit: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).gitCommit({
          message: text(input.message), paths: input.paths as string[], expectedRevision: optionalNumber(input.expected_revision), idempotencyKey: text(input.idempotency_key)
        }));
      },
      forge_git_outgoing_diff: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).gitOutgoingDiff({ base: text(input.base) }));
      },
      forge_git_push: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id);
        const branch = text(input.branch);
        const base = text(input.base);
        const diffHash = text(input.expected_diff_hash);
        const approvalId = input.approval_id ? text(input.approval_id) : undefined;
        if (!approvalId) {
          const approval = await requestApproval(env, identity, workspaceId, 'git.push', `Push ${branch} to GitHub`, { branch, base, diffHash });
          throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: 'Open the Forge approval URL, approve this exact push, then retry with approval_id.', retryable: false, details: approval });
        }
        await requireApproval(env, identity, approvalId, workspaceId, 'git.push', { branch, base, diffHash });
        try {
          const result = await (await authorizedCoordinator(env, identity, workspaceId)).gitPush({
            branch, base, expectedDiffHash: diffHash, expectedRevision: optionalNumber(input.expected_revision), idempotencyKey: text(input.idempotency_key)
          });
          await completeApproval(env, approvalId, true);
          return asRecord(result);
        } catch (error) {
          await completeApproval(env, approvalId, false);
          throw error;
        }
      },
      forge_pull_request_create: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id);
        const head = text(input.head);
        const base = text(input.base);
        const title = text(input.title);
        const approvalId = input.approval_id ? text(input.approval_id) : undefined;
        if (!approvalId) {
          const approval = await requestApproval(env, identity, workspaceId, 'pull_request.create', `Create draft pull request ${head} → ${base}`, { head, base, title });
          throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: 'Open the Forge approval URL, approve this draft PR, then retry with approval_id.', retryable: false, details: approval });
        }
        await requireApproval(env, identity, approvalId, workspaceId, 'pull_request.create', { head, base, title });
        try {
          const state = await (await authorizedCoordinator(env, identity, workspaceId)).getState();
          const result = await createDraftPullRequest(env, identity, state.repository, { head, base, title, body: text(input.body) });
          await completeApproval(env, approvalId, true);
          return result;
        } catch (error) {
          await completeApproval(env, approvalId, false);
          throw error;
        }
      },
      forge_preview_expose: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id) as WorkspaceId;
        const value = await (await authorizedCoordinator(env, identity, workspaceId)).previewExpose({
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
      forge_review_capture: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id) as WorkspaceId;
        const previewId = text(input.preview_id);
        const detail = await (await authorizedCoordinator(env, identity, workspaceId)).getPreviewInternal(previewId);
        if (new Date(detail.preview.expiresAt).getTime() <= Date.now()) {
          throw new ForgeError({
            code: 'FORGE_PREVIEW_UNAVAILABLE',
            message: 'Preview has expired.',
            retryable: false
          });
        }
        const artifacts = new R2ArtifactStore(env.ARTIFACTS);
        const browser = new CloudflareBrowserProvider(env.BROWSER, artifacts, detail.workspace.tenantId);
        const captures = input.captures as Array<{ selection: string; route: string; state: string }>;
        const viewports = input.viewports as Array<{ id: string; width: number; height: number }>;
        const evidence: Array<Record<string, unknown>> = [];
        for (const capture of captures) {
          for (const viewport of viewports) {
            const browserInput = {
              workspaceId,
              url: `${env.FORGE_PUBLIC_ORIGIN}/__forge_browser/${workspaceId}/${previewId}/`,
              path: capture.route,
              headers: {
                'x-forge-internal-preview': env.FORGE_INTERNAL_PREVIEW_KEY,
                'x-forge-browser-workspace': workspaceId,
                'x-forge-browser-preview': previewId
              },
              viewport: { width: viewport.width, height: viewport.height },
              operationId: ids.operation(),
              repositoryCommit: detail.workspace.currentCommit,
              workspaceRevision: detail.workspace.revision
            };
            const captured = await browser.captureEvidence({ ...browserInput, fullPage: false });
            evidence.push({
              selection: capture.selection,
              route: capture.route,
              environment: viewport.id,
              state: capture.state,
              requestedViewport: { width: viewport.width, height: viewport.height },
              observedViewport: { width: viewport.width, height: viewport.height },
              screenshot: captured.screenshot,
              accessibility: captured.accessibility,
              inspected: false,
              limitations: []
            });
          }
        }
        return {
          schemaVersion: 1,
          provider: 'forge',
          workspaceId,
          repository: `${detail.workspace.repository.owner}/${detail.workspace.repository.name}`,
          commit: detail.workspace.currentCommit,
          workspaceRevision: detail.workspace.revision,
          capturedAt: new Date().toISOString(),
          previewId,
          evidence,
          limitations: [],
          nextStep: 'Call forge_artifact_get for each evidence[].screenshot.artifactId, inspect the image, then mark that evidence inspected in Parallax.'
        };
      },
      forge_browser_screenshot: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id) as WorkspaceId;
        const previewId = text(input.preview_id);
        const detail = await (await authorizedCoordinator(env, identity, workspaceId)).getPreviewInternal(previewId);
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
          url: `${env.FORGE_PUBLIC_ORIGIN}/__forge_browser/${workspaceId}/${previewId}/`,
          path: text(input.path),
          headers: {
            'x-forge-internal-preview': env.FORGE_INTERNAL_PREVIEW_KEY,
            'x-forge-browser-workspace': workspaceId,
            'x-forge-browser-preview': previewId
          },
          viewport: input.viewport as { width: number; height: number },
          fullPage: Boolean(input.full_page),
          operationId: ids.operation(),
          repositoryCommit: detail.workspace.currentCommit,
          workspaceRevision: detail.workspace.revision
        });
        const object = await env.ARTIFACTS.get(
          `tenant/${identity.tenantId}/workspace/${workspaceId}/artifacts/${result.artifactId}`
        );
        if (!object || object.size > 4_000_000) return asRecord(result);
        return forgeToolResponse(
          { ...result, artifact_kind: 'browser.screenshot' },
          [{ type: 'image', data: base64(await object.arrayBuffer()), mimeType: result.contentType }]
        );
      },
      forge_browser_accessibility_tree: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id) as WorkspaceId;
        const previewId = text(input.preview_id);
        const detail = await (await authorizedCoordinator(env, identity, workspaceId)).getPreviewInternal(previewId);
        if (new Date(detail.preview.expiresAt).getTime() <= Date.now()) {
          throw new ForgeError({
            code: 'FORGE_PREVIEW_UNAVAILABLE',
            message: 'Preview has expired.',
            retryable: false
          });
        }
        const artifacts = new R2ArtifactStore(env.ARTIFACTS);
        const browser = new CloudflareBrowserProvider(env.BROWSER, artifacts, detail.workspace.tenantId);
        const result = await browser.accessibilityTree({
          workspaceId,
          url: `${env.FORGE_PUBLIC_ORIGIN}/__forge_browser/${workspaceId}/${previewId}/`,
          path: text(input.path),
          headers: {
            'x-forge-internal-preview': env.FORGE_INTERNAL_PREVIEW_KEY,
            'x-forge-browser-workspace': workspaceId,
            'x-forge-browser-preview': previewId
          },
          viewport: input.viewport as { width: number; height: number },
          operationId: ids.operation(),
          repositoryCommit: detail.workspace.currentCommit,
          workspaceRevision: detail.workspace.revision
        });
        return asRecord(result);
      },
      forge_artifact_get: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id);
        const state = await (await authorizedCoordinator(env, identity, workspaceId)).getState();
        const artifactId = text(input.artifact_id);
        const object = await env.ARTIFACTS.get(
          `tenant/${identity.tenantId}/workspace/${workspaceId}/artifacts/${artifactId}`
        );
        if (!object) {
          throw new ForgeError({
            code: 'FORGE_ARTIFACT_NOT_FOUND',
            message: 'Artifact was not found in this workspace.',
            retryable: false
          });
        }
        const maxBytes = number(input.max_bytes);
        if (object.size > maxBytes) {
          throw new ForgeError({
            code: 'FORGE_OUTPUT_TRUNCATED',
            message: 'Artifact is larger than the requested output limit.',
            retryable: false,
            details: { sizeBytes: object.size, maxBytes }
          });
        }
        const mimeType = object.httpMetadata?.contentType ?? 'application/octet-stream';
        const value = {
          artifact_id: artifactId,
          workspace_id: workspaceId,
          workspace_revision: state.revision,
          content_type: mimeType,
          size_bytes: object.size,
          metadata: object.customMetadata ?? {}
        };
        if (!mimeType.startsWith('image/')) return value;
        return forgeToolResponse(value, [{
          type: 'image',
          data: base64(await object.arrayBuffer()),
          mimeType
        }]);
      },
      forge_workspace_destroy: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id) as WorkspaceId;
        const idempotencyKey = text(input.idempotency_key);
        const request = await (await authorizedCoordinator(env, identity, workspaceId)).requestDestroy({
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
