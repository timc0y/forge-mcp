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
import type { BrowserActionStep } from '@forge/browser-core';
import { workflowInstanceId } from '@forge/workflows-cloudflare';
import { classifyCommand } from '@forge/policy';
import type { Env } from './env';
import { registerForgeConsole } from './forge-console';
import type { WorkspaceCoordinator } from './workspace-coordinator';
import { reserveWorkspaceSlot, releaseWorkspaceSlot } from './capacity';
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

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
        const failures: Array<Record<string, unknown>> = [];
        const skipped: Array<Record<string, unknown>> = [];
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
        // Each (capture × viewport) cell is captured independently so one slow
        // or failing route cannot discard evidence that already succeeded. A
        // soft deadline stops the loop before the outer tool timeout would, and
        // any cells left uncaptured are reported as skipped rather than lost.
        const startedAt = Date.now();
        const deadlineMs = 110_000;
        const cells = captures.flatMap((capture) => viewports.map((viewport) => ({ capture, viewport })));
        for (const { capture, viewport } of cells) {
          if (Date.now() - startedAt > deadlineMs) {
            skipped.push({ route: capture.path, environment: viewport.id, reason: 'capture_deadline_reached' });
            continue;
          }
          let result;
          try {
            result = await browser.captureEvidence({
              workspaceId,
              url: text(input.url),
              path: capture.path,
              viewport: { width: viewport.width, height: viewport.height },
              fullPage: Boolean(input.full_page),
              operationId: ids.operation(),
              workspaceRevision: 1
            });
          } catch (error) {
            failures.push({
              route: capture.path,
              environment: viewport.id,
              reason: error instanceof Error ? error.message.slice(0, 500) : 'Capture failed.'
            });
            continue;
          }
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
          // The inline image is a convenience; a failure fetching it must not
          // demote an evidence cell that was already captured and stored.
          try {
            const object = await env.ARTIFACTS.get(
              `tenant/${identity.tenantId}/workspace/${workspaceId}/artifacts/${result.screenshot.artifactId}`
            );
            if (object && object.size <= 4_000_000) {
              content.push({ type: 'image', data: base64(await object.arrayBuffer()), mimeType: 'image/png' });
            }
          } catch {
            // Evidence remains valid and retrievable via forge_artifact_get.
          }
        }
        if (evidence.length === 0) {
          throw new ForgeError({
            code: 'FORGE_PREVIEW_UNAVAILABLE',
            message: 'No screenshots could be captured from the requested URL.',
            retryable: true,
            details: { failures, skipped }
          });
        }
        const complete = failures.length === 0 && skipped.length === 0;
        const packet = {
          schemaVersion: 1,
          provider: 'forge',
          executionMode: 'url_review',
          containerUsed: false,
          workspaceId,
          sourceUrl: text(input.url),
          capturedAt: new Date().toISOString(),
          requestedCaptures: cells.length,
          capturedCount: evidence.length,
          complete,
          evidence,
          failures,
          skipped,
          limitations: ['Static screenshot evidence does not prove interactions that were not executed.'],
          nextStep: complete
            ? 'Inspect every returned MCP image, then pass the evidence to Parallax with inspected set to true.'
            : 'Inspect the returned images, then re-run forge_review for the routes listed in failures and skipped (fewer routes per call captures more reliably).'
        };
        const summary = complete
          ? `Captured ${evidence.length} screenshots without starting a container. Inspect every returned image before marking its evidence inspected.`
          : `Captured ${evidence.length} of ${cells.length} screenshots without starting a container (${failures.length} failed, ${skipped.length} skipped). Inspect the returned images and re-run the remaining routes in smaller batches.`;
        content.unshift({ type: 'text', text: summary });
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
        await reserveWorkspaceSlot(env.METADATA, workspaceId);
        let result;
        try {
          result = await coordinator(env, workspaceId).initialize({
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
            persistence: 'ephemeral',
            bootstrap: Boolean(input.bootstrap),
            idempotencyKey,
            actor: { type: 'agent', id: identity.subject }
          });
        } catch (error) {
          await releaseWorkspaceSlot(env.METADATA, workspaceId);
          throw error;
        }
        if (['failed', 'suspended', 'destroyed'].includes(result.state)) {
          await releaseWorkspaceSlot(env.METADATA, workspaceId);
        }
        if (!result.replay || result.state === 'requested') {
          const workflowId = workflowInstanceId('provision', workspaceId);
          try {
            await env.PROVISION_WORKFLOW.create({
              id: workflowId,
              params: { workspaceId, bootstrap: Boolean(input.bootstrap) }
            });
          } catch (createError) {
            try {
              await env.PROVISION_WORKFLOW.get(workflowId);
            } catch {
              await releaseWorkspaceSlot(env.METADATA, workspaceId);
              throw createError;
            }
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
        const workspaceId = text(input.workspace_id);
        const command = text(input.command);
        const cwd = text(input.cwd);
        const networkPolicy = text(input.network_policy) as never;
        const workspace = await authorizedCoordinator(env, identity, workspaceId);
        const decision = classifyCommand(command, networkPolicy);
        const approvalId = input.approval_id ? text(input.approval_id) : undefined;
        const environment = input.environment as Record<string, string>;
        const environmentHash = await sha256(JSON.stringify(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))));
        const approvalPayload = { command, cwd, networkPolicy, environmentHash };
        let claimedApproval = false;
        if (decision.allowed && decision.approvalRequired) {
          if (!approvalId) {
            const approval = await requestApproval(env, identity, workspaceId, 'shell.exec', `Run ${decision.classification} command`, approvalPayload);
            throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: 'Open the Forge approval URL, approve this exact command, then retry with approval_id.', retryable: false, details: approval });
          }
          await requireApproval(env, identity, approvalId, workspaceId, 'shell.exec', approvalPayload);
          claimedApproval = true;
        }
        try {
          const result = await workspace.shellExec({
            command,
            cwd,
            timeoutMs: number(input.timeout_ms),
            environment,
            networkPolicy,
            outputLimitBytes: number(input.output_limit_bytes),
            expectedRevision: optionalNumber(input.expected_revision),
            idempotencyKey: text(input.idempotency_key),
            approved: claimedApproval
          });
          if (claimedApproval && approvalId) await completeApproval(env, approvalId, true);
          return asRecord(result);
        } catch (error) {
          if (claimedApproval && approvalId) await completeApproval(env, approvalId, false);
          throw error;
        }
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
        const body = text(input.body);
        const approvalId = input.approval_id ? text(input.approval_id) : undefined;
        if (!approvalId) {
          const approval = await requestApproval(env, identity, workspaceId, 'pull_request.create', `Create draft pull request ${head} → ${base}`, { head, base, title, body });
          throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: 'Open the Forge approval URL, approve this draft PR, then retry with approval_id.', retryable: false, details: approval });
        }
        await requireApproval(env, identity, approvalId, workspaceId, 'pull_request.create', { head, base, title, body });
        try {
          const state = await (await authorizedCoordinator(env, identity, workspaceId)).getState();
          const result = await createDraftPullRequest(env, identity, state.repository, { head, base, title, body });
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
      forge_browser_act: async (input) => {
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
        const rawSteps = input.steps as Array<{
          kind: BrowserActionStep['kind'];
          selector?: string;
          value?: string;
          key?: string;
          text?: string;
          path?: string;
          timeout_ms?: number;
        }>;
        const steps: BrowserActionStep[] = rawSteps.map((step) => {
          switch (step.kind) {
            case 'navigate':
              return { kind: 'navigate', path: text(step.path ?? '/') };
            case 'click':
              return { kind: 'click', selector: text(step.selector) };
            case 'fill':
              return { kind: 'fill', selector: text(step.selector), value: text(step.value ?? '') };
            case 'press':
              return { kind: 'press', key: text(step.key) };
            case 'wait_for_selector':
              return { kind: 'wait_for_selector', selector: text(step.selector), timeoutMs: optionalNumber(step.timeout_ms) };
            case 'wait_for_text':
              return { kind: 'wait_for_text', text: text(step.text), timeoutMs: optionalNumber(step.timeout_ms) };
            case 'wait':
              return { kind: 'wait', timeoutMs: optionalNumber(step.timeout_ms) ?? 1_000 };
            case 'reload':
            default:
              return { kind: 'reload' };
          }
        });
        const artifacts = new R2ArtifactStore(env.ARTIFACTS);
        const browser = new CloudflareBrowserProvider(env.BROWSER, artifacts, detail.workspace.tenantId);
        const result = await browser.act({
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
          steps,
          operationId: ids.operation(),
          repositoryCommit: detail.workspace.currentCommit,
          workspaceRevision: detail.workspace.revision
        });
        const value = {
          schemaVersion: 1,
          provider: 'forge',
          workspaceId,
          previewId,
          commit: detail.workspace.currentCommit,
          workspaceRevision: detail.workspace.revision,
          capturedAt: new Date().toISOString(),
          stepsExecuted: result.stepsExecuted,
          finalUrl: result.finalUrl,
          screenshot: result.screenshot,
          accessibility: result.accessibility,
          inspected: false,
          nextStep: 'Call forge_artifact_get for screenshot.artifactId, inspect the image, then record the journey result in Parallax.'
        };
        const object = await env.ARTIFACTS.get(
          `tenant/${detail.workspace.tenantId}/workspace/${workspaceId}/artifacts/${result.screenshot.artifactId}`
        );
        if (!object || object.size > 4_000_000) return value;
        return forgeToolResponse(value, [{ type: 'image', data: base64(await object.arrayBuffer()), mimeType: 'image/png' }]);
      },
      forge_artifact_get: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id);
        const artifactId = text(input.artifact_id);
        // A container-backed workspace has a coordinator record that binds it to
        // the caller's tenant and project. A URL-review workspace (from
        // forge_review) has no coordinator, so its artifacts are only reachable
        // through the tenant-scoped R2 key. Fall back to that path when — and
        // only when — no coordinator record exists, so real cross-project
        // workspaces still fail the authorization check above.
        let workspaceRevision: number | null = null;
        let source: 'workspace' | 'url_review' = 'workspace';
        const state = await coordinator(env, workspaceId).tryGetState();
        if (state) {
          if (state.tenantId !== identity.tenantId || state.projectId !== identity.projectId) {
            throw new ForgeError({
              code: 'FORGE_PERMISSION_DENIED',
              message: 'The workspace is outside the authenticated project.',
              retryable: false
            });
          }
          workspaceRevision = state.revision;
        } else {
          source = 'url_review';
        }
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
          workspace_revision: workspaceRevision,
          source,
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
