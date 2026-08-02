import { ForgeError, ids, type ProcessId, type TenantId, type WorkspaceId } from '@forge/core';
import { issueCapability } from '@forge/capabilities';
import {
  forgeToolResponse,
  type ForgeToolHandlers,
  AGENT_OUTPUT_SPILL_BYTES,
  AGENT_OUTPUT_TAIL_BYTES,
  tailBytes,
  utf8Bytes
} from '@forge/mcp-core';
import { R2ArtifactStore } from '@forge/artifacts-r2';
import type { BrowserActionStep } from '@forge/browser-core';
import { selectBrowserProvider } from '../browser-router';
import { classifyCommand } from '@forge/policy';
import {
  durabilityNextStep,
  resolveDeployWorkflow,
  type DeployWorkflowId
} from '@forge/application';
import { normalizeViewports, prepareInlineImages } from '../review-images';
import { resolveWorkspaceId } from '../workspace-resolve';
import { storeGallery } from '../review-gallery';
import type { Env } from '../env';
import { vaultService } from '../vault';
import { completeApproval, requestApproval, requireApproval } from '../github';
import { stripAnsi, summariseCommandOutput } from '../command-summary';
import {
  mayAutoApproveShell, parseWorkersDevUrl, parseWranglerWorkerName, spillTextArtifact,
  withDeadline, summarizeStructure, mapWithConcurrency,
  REVIEW_CAPTURE_CONCURRENCY, findingCountOf, toActionSteps, executorCoordinator,
  text, number, optionalNumber, asRecord, workspaceAddress, idempotency, sha256
} from './helpers';
import type { ExecutionHandlerDependencies } from './types';

type WorkflowTool = 'forge_shell' | 'forge_process_logs' | 'forge_process_list' | 'forge_process_stop' | 'forge_process_wait' | 'forge_deps_install' | 'forge_deploy' | 'forge_cloudflare_deploy' | 'forge_preview_expose' | 'forge_preview';

type DeployPrefer = 'auto' | DeployWorkflowId;

async function runEnvDrivenDeploy(
  env: Env,
  deps: ExecutionHandlerDependencies,
  input: Record<string, unknown>,
  preferDefault: DeployPrefer
): Promise<Record<string, unknown>> {
  const identity = deps.identity();
  const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
  const preferInput = input.workflow === undefined ? preferDefault : text(input.workflow);
  const prefer: DeployPrefer =
    preferInput === 'cloudflare_wrangler' ? 'cloudflare_wrangler' : 'auto';
  const cwd = input.cwd === undefined ? '/workspace/repo' : text(input.cwd);
  const expectedUrl = input.expected_url === undefined ? undefined : text(input.expected_url);
  const attached = await vaultService(env).attachedEnv(identity.tenantId as TenantId, workspaceId);
  const resolved = resolveDeployWorkflow(
    attached.vars,
    prefer === 'auto' ? undefined : prefer
  );
  if (!resolved.ok) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message:
        prefer === 'cloudflare_wrangler'
          ? 'Attach a vault secret that includes a Cloudflare API token and account id (CLOUDFLARE_* or CF_* aliases), then retry.'
          : 'No deploy workflow matched the attached vault env vars. forge_deploy chooses from those names — create/attach credentials first.',
      retryable: false,
      details: {
        reason: resolved.reason,
        attached_var_names: resolved.attached_var_names,
        workflows: resolved.workflows.map((w) => ({
          id: w.id,
          label: w.label,
          accepts_env: w.accepts
        })),
        ...(resolved.partial ? { partial: resolved.partial } : {}),
        next_step: resolved.next_step
      }
    });
  }

  const { resolution } = resolved;
  const command =
    input.command === undefined
      ? resolution.workflow === 'cloudflare_wrangler'
        ? 'npx wrangler deploy'
        : 'npx wrangler deploy'
      : text(input.command);
  const decision = classifyCommand(command, 'development');
  if (decision.classification !== 'external_side_effect') {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message:
        'forge_deploy only runs provider deploy/publish/delete commands selected from attached env. Use forge_shell for probes (including --dry-run).',
      retryable: false
    });
  }
  if (/(^|\s)--dry-run(\s|$)/i.test(command)) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'Dry-run is not a deploy. Use forge_shell with wrangler deploy --dry-run instead.',
      retryable: false
    });
  }

  const accountId = resolution.accountId;
  const approvalAction = 'cloudflare.deploy' as const;
  const approvalSummary = `Deploy (${resolution.workflow}) to Cloudflare account ${accountId}`;
  const approvalPayload = {
    workflow: resolution.workflow,
    command,
    cwd,
    accountId,
    matchedEnv: resolution.matched,
    expectedUrl: expectedUrl ?? null
  };
  let approvalId = input.approval_id ? text(input.approval_id) : undefined;
  if (!approvalId) {
    const approval = await requestApproval(
      env,
      identity,
      workspaceId,
      approvalAction,
      approvalSummary,
      approvalPayload
    );
    if (approval.already_approved) {
      approvalId = approval.approval_id;
      await requireApproval(env, identity, approvalId, workspaceId, approvalAction, approvalPayload);
    } else {
      const inline = await deps.tryResolveApprovalInline(identity, approval, approvalSummary);
      if (!inline) {
        throw new ForgeError({
          code: 'FORGE_APPROVAL_REQUIRED',
          message: 'Deploy needs human approval. Open the approval URL, approve, then retry with approval_id.',
          retryable: false,
          details: { kind: 'approval', action: approvalAction, workflow: resolution.workflow, ...approval }
        });
      }
      approvalId = inline;
      await requireApproval(env, identity, approvalId, workspaceId, approvalAction, approvalPayload);
    }
  } else {
    await requireApproval(env, identity, approvalId, workspaceId, approvalAction, approvalPayload);
  }

  const workspace = await executorCoordinator(env, identity, workspaceId);
  const started = asRecord(
    await workspace.processStart({
      command,
      cwd,
      environment: resolution.processEnv,
      networkPolicy: 'development',
      expectedRevision: undefined,
      idempotencyKey: text(input.idempotency_key),
      approved: true
    })
  );
  const startedValue =
    started.value && typeof started.value === 'object'
      ? (started.value as Record<string, unknown>)
      : started;
  const processId = startedValue.id ?? started.processId ?? started.id;
  if (typeof processId !== 'string' || !processId.startsWith('proc_')) {
    throw new ForgeError({
      code: 'FORGE_WORKSPACE_CONFLICT',
      message:
        'The deploy process did not return a process id, so Forge cannot track its outcome. Call forge_process_list before retrying with a new idempotency key.',
      retryable: false
    });
  }
  const waited = await withDeadline(
    workspace.processWait({
      processId: processId as ProcessId,
      timeoutMs: 15_000
    }) as unknown as Promise<Record<string, unknown>>,
    16_000
  );
  if (!waited || waited.timedOut) {
    if (approvalId) await completeApproval(env, approvalId, true, { reusable: true });
    return {
      deployed: false,
      accepted: true,
      workflow: resolution.workflow,
      process_id: processId,
      approval_id: approvalId,
      next_step: `Deploy is still running as ${processId}. Call forge_process_wait with that process_id; do not restart it. Then retry forge_deploy with the same idempotency_key and approval_id to obtain a verified deploy_receipt.`
    };
  }
  const process = waited.process as { exitCode?: number };
  const logs = asRecord(await workspace.processLogs({ processId: processId as ProcessId }));
  const combined = String(logs.data ?? '');
  const redacted = await vaultService(env).redactOutput(combined, identity.tenantId as TenantId, workspaceId);
  if (process.exitCode !== 0) {
    if (approvalId) await completeApproval(env, approvalId, false);
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `Deploy failed (exit ${String(process.exitCode)}). Inspect forge_process_logs for ${processId}; do not claim the service is live.`,
      retryable: true,
      details: {
        workflow: resolution.workflow,
        process_id: processId,
        exitCode: process.exitCode,
        output_tail: redacted.slice(-4_000)
      }
    });
  }
  const workerName = parseWranglerWorkerName(redacted);
  const publishedUrl = expectedUrl ?? parseWorkersDevUrl(redacted);
  let httpStatus: number | null = null;
  let verifiedUrl: string | null = null;
  if (publishedUrl) {
    try {
      const probe = await fetch(publishedUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(8_000)
      });
      httpStatus = probe.status;
      // Any HTTP response from the hostname proves the Worker route exists;
      // 404 app content still means the worker is deployed.
      verifiedUrl = publishedUrl;
    } catch {
      httpStatus = null;
      verifiedUrl = null;
    }
  }
  if (approvalId) await completeApproval(env, approvalId, true);
  await deps.recordAudit(
    'cloudflare.deploy',
    identity.tenantId,
    {
      workflow: resolution.workflow,
      accountId,
      workerName,
      verifiedUrl,
      httpStatus,
      command,
      matchedEnv: resolution.matched
    },
    { workspaceId }
  );
  const deployReceipt = {
    workflow: resolution.workflow,
    account_id: accountId,
    worker_name: workerName,
    verified_url: verifiedUrl,
    http_status: httpStatus,
    command,
    matched_env: resolution.matched
  };
  let outputArtifactId: string | undefined;
  if (utf8Bytes(redacted) > AGENT_OUTPUT_SPILL_BYTES) {
    const spilled = await spillTextArtifact(env, identity, workspaceId, 'deploy-output', redacted);
    outputArtifactId = spilled.artifact_id;
  }
  const includeOutput = input.include_output === true;
  return {
    deployed: true,
    accepted: true,
    workflow: resolution.workflow,
    process_id: processId,
    deploy_receipt: deployReceipt,
    ...(outputArtifactId ? { output_artifact_id: outputArtifactId } : {}),
    ...(includeOutput ? { stdout_tail: redacted.slice(-3_000) } : {}),
    next_step: verifiedUrl
      ? `Only claim this URL is live: ${verifiedUrl} (HTTP ${httpStatus}). Echo deploy_receipt only.${outputArtifactId ? ` Full logs: ${outputArtifactId}.` : ''}`
      : `Deploy succeeded but URL not verified. Do not invent a live URL.${outputArtifactId ? ` Inspect ${outputArtifactId} via forge_artifact_get.` : ' Pass expected_url.'}`
  };
}

/** Focused execution workflows behind the ForgeToolHandlers seam. */
export function executionToolHandlers(env: Env, deps: ExecutionHandlerDependencies): Pick<ForgeToolHandlers, WorkflowTool> {
  return {
      forge_shell: async (input) => {
        const identity = deps.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
        const command = text(input.command);
        const cwd = text(input.cwd);
        const networkPolicy = text(input.network_policy) as never;
        const workspace = await executorCoordinator(env, identity, workspaceId);
        const decision = classifyCommand(command, networkPolicy);
        let approvalId = input.approval_id ? text(input.approval_id) : undefined;
        const userEnv = input.environment as Record<string, string>;
        const attached = await vaultService(env).attachedEnv(identity.tenantId as TenantId, workspaceId);
        const environment = { ...attached.vars, ...userEnv };
        const environmentHash = await sha256(JSON.stringify(Object.entries(userEnv).sort(([left], [right]) => left.localeCompare(right))));
        const approvalPayload = { command, cwd, networkPolicy, environmentHash };
        let claimedApproval = false;
        if (decision.allowed && decision.approvalRequired) {
          if (mayAutoApproveShell(env, decision.classification, networkPolicy)) {
            claimedApproval = true;
          } else if (!approvalId) {
            const approval = await requestApproval(env, identity, workspaceId, 'shell.exec', `Run ${decision.classification} command`, approvalPayload);
            if (approval.already_approved) {
              approvalId = approval.approval_id;
              await requireApproval(env, identity, approvalId, workspaceId, 'shell.exec', approvalPayload);
              claimedApproval = true;
            } else {
              const inline = await deps.tryResolveApprovalInline(identity, approval, `Run ${decision.classification} command`);
              if (!inline) {
                throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: 'This command needs human approval. Open the approval URL, approve this exact command, then retry the call with approval_id.', retryable: false, details: { kind: 'approval', action: 'shell.exec', ...approval } });
              }
              approvalId = inline;
              await requireApproval(env, identity, approvalId, workspaceId, 'shell.exec', approvalPayload);
              claimedApproval = true;
            }
          } else {
            await requireApproval(env, identity, approvalId, workspaceId, 'shell.exec', approvalPayload);
            claimedApproval = true;
          }
        }
        // A host kills the request long before Forge's own timeout fires:
        // timeout_ms defaults to 300s while ChatGPT and Claude cut the
        // transport at around 60. Anything slower than that returned no
        // process id, no output and no handle â€” while the command kept
        // running â€” which is the worst shape a failure can have. Route it
        // through the managed-process path instead, so a long command always
        // comes back as something the agent can wait on.
        const HOST_SAFE_SYNC_MS = 30_000;
        const requestedTimeout = number(input.timeout_ms);
        const escalated = input.async !== true
          && input.mode !== 'read_only'
          && Number.isFinite(requestedTimeout)
          && requestedTimeout > HOST_SAFE_SYNC_MS;
        try {
          if (input.async === true || escalated) {
            if (input.mode === 'read_only') {
              throw new ForgeError({
                code: 'FORGE_VALIDATION_FAILED',
                message: 'async:true cannot be combined with mode:read_only. Use a foreground read-only command, or omit mode for a managed process.',
                retryable: false,
                details: { allowedNextActions: ['forge_shell'] }
              });
            }
            const proc = await workspace.processStart({
              command,
              cwd: cwd.replace(/\/+$/u, '') || cwd,
              environment,
              networkPolicy,
              expectedRevision: optionalNumber(input.expected_revision),
              idempotencyKey: idempotency(input.idempotency_key),
              approved: claimedApproval
            });
            if (claimedApproval && approvalId) await completeApproval(env, approvalId, true, { reusable: true });
            const procRecord = proc as unknown as Record<string, unknown>;
            const value = (procRecord.value && typeof procRecord.value === 'object'
              ? procRecord.value
              : procRecord) as Record<string, unknown>;
            const processId = value.id ?? procRecord.processId ?? procRecord.id;
            if (typeof processId !== 'string' || !processId.startsWith('proc_')) {
              throw new ForgeError({
                code: 'FORGE_WORKSPACE_CONFLICT',
                message: 'Managed process start did not return a process id; inspect forge_workspace_get before retrying with a new idempotency key.',
                retryable: false,
                details: { replay: Boolean(procRecord.replay), allowedNextActions: ['forge_workspace_get', 'forge_process_list'] }
              });
            }
            const status = String(value.status ?? procRecord.status ?? 'running');
            return {
              processId,
              status,
              command,
              async: true,
              replay: Boolean(procRecord.replay),
              replayed: Boolean(procRecord.replayed ?? procRecord.replay),
              operationId: procRecord.operationId,
              workspaceRevision: procRecord.workspaceRevision,
              mutatesFilesystem: value.mutatesFilesystem ?? procRecord.mutatesFilesystem,
              remote_persisted: false,
              executor_filesystem: 'ephemeral',
              allowedNextActions: ['forge_process_wait', 'forge_process_logs', 'forge_process_list'],
              ...(escalated && input.async !== true
                ? {
                    escalated_to_background: true,
                    escalated_reason: `timeout_ms ${requestedTimeout}ms exceeds the ${HOST_SAFE_SYNC_MS}ms a client will hold a request open, so this runs as a managed process instead of failing the transport.`
                  }
                : {}),
              next_step: `Running in the background as ${processId}. Call forge_process_wait with that process_id; each call observes for at most 30000ms, or use forge_process_logs to inspect output. Do not re-run the command.`
            };
          }
          const result = await workspace.shellExec({
            command,
            cwd,
            timeoutMs: Math.min(number(input.timeout_ms), input.mode === 'read_only' ? 35_000 : HOST_SAFE_SYNC_MS),
            environment,
            networkPolicy,
            outputLimitBytes: number(input.output_limit_bytes),
            expectedRevision: optionalNumber(input.expected_revision),
            idempotencyKey: idempotency(input.idempotency_key),
            approved: claimedApproval,
            mode: input.mode === 'read_only' || input.mode === 'mutating' ? input.mode : undefined
          });
          if (claimedApproval && approvalId) await completeApproval(env, approvalId, true, { reusable: true });
          // Colour codes are 40% of a real test-run response and mean nothing
          // to a reader that is not a terminal: one `[31m` is ten JSON
          // characters the agent cannot act on. Stripping here â€” before
          // redaction, the summariser, the tails and the artifact spill â€” also
          // makes the tail budget carry ~2.4x more actual output, which is the
          // difference between seeing the failing assertion and seeing the
          // escape codes around it. Redaction runs on clean text too, so a
          // secret printed with colour in the middle still matches.
          let stdout = stripAnsi('stdout' in result ? String(result.stdout ?? '') : '');
          let stderr = stripAnsi('stderr' in result ? String(result.stderr ?? '') : '');
          if (attached.redact.size > 0) {
            stdout = await vaultService(env).redactOutput(stdout, identity.tenantId as TenantId, workspaceId);
            stderr = await vaultService(env).redactOutput(stderr, identity.tenantId as TenantId, workspaceId);
          }
          const exitCode = 'exitCode' in result ? Number(result.exitCode) : undefined;
          const compact = input.compact !== false;
          // Replace the log with the answer when the command's output has a
          // known shape. A 300KB test run becomes a headline plus the failing
          // test names â€” the difference between a session that can run tests,
          // read failures, fix and re-run, and one that dies on the first run.
          // The full log is still spilled to an artifact below.
          const summary = summariseCommandOutput({ command, output: `${stdout}\n${stderr}`, exitCode });
          const combinedBytes = utf8Bytes(stdout) + utf8Bytes(stderr);
          let outputArtifactId: string | undefined;
          if (combinedBytes > AGENT_OUTPUT_SPILL_BYTES) {
            const spilled = await spillTextArtifact(
              env,
              identity,
              workspaceId,
              'shell-output',
              `===STDOUT===\n${stdout}\n===STDERR===\n${stderr}\n`
            );
            outputArtifactId = spilled.artifact_id;
          }
          const base = asRecord(result);
          const { stdout: _s, stderr: _e, ...rest } = base;
          const readOnly = input.mode === 'read_only' || rest.mode === 'read_only';
          const executionPersistence = {
            remote_persisted: false as const,
            executor_filesystem: 'ephemeral' as const,
            persistence_notice: durabilityNextStep(readOnly ? 'read_only' : 'mutating')
          };
          const next = durabilityNextStep(readOnly ? 'read_only' : 'mutating');
          if (compact) {
            return {
              ...rest,
              ...executionPersistence,
              exitCode,
              compact: true,
              truncated: Boolean(result.truncated) || Boolean(outputArtifactId),
              ...(summary ? { result_summary: summary } : {}),
              // With a summary the tails are noise; without one they are the
              // only thing the agent has.
              stdout_tail: tailBytes(stdout, summary ? 800 : AGENT_OUTPUT_TAIL_BYTES),
              stderr_tail: tailBytes(stderr, summary ? 800 : AGENT_OUTPUT_TAIL_BYTES),
              allowedNextActions: readOnly
                ? ['forge_files_read', 'forge_edit', 'forge_shell', 'forge_workspace_get']
                : ['forge_files_read', 'forge_edit', 'forge_shell'],
              next_step: outputArtifactId
                ? `Full output in ${outputArtifactId} (forge_artifact_get). ${next}`
                : next
            };
          }
          return {
            ...rest,
            ...executionPersistence,
            exitCode,
            compact: false,
            stdout,
            stderr,
            ...(outputArtifactId ? { output_artifact_id: outputArtifactId } : {}),
            allowedNextActions: readOnly
              ? ['forge_files_read', 'forge_edit', 'forge_shell', 'forge_workspace_get']
              : ['forge_files_read', 'forge_edit', 'forge_shell'],
            next_step: next
          };
        } catch (error) {
          if (claimedApproval && approvalId) await completeApproval(env, approvalId, false);
          throw error;
        }
      },
      forge_process_logs: async (input) => {
        const identity = deps.identity();
        return asRecord(await (await executorCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)))).processLogs({
          processId: text(input.process_id) as ProcessId,
          cursor: input.cursor ? text(input.cursor) : undefined
        }));
      },
      forge_process_list: async (input) => {
        const identity = deps.identity();
        const workspace = await executorCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)));
        if (input.process_id) {
          return asRecord(await workspace.processGet({ processId: text(input.process_id) as ProcessId }));
        }
        return asRecord(await workspace.processList());
      },
      forge_process_stop: async (input) => {
        const identity = deps.identity();
        const workspace = await executorCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)));
        const args = {
          processId: text(input.process_id) as ProcessId,
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: idempotency(input.idempotency_key)
        };
        return asRecord(input.force ? await workspace.processCancel(args) : await workspace.processStop(args));
      },
      forge_process_wait: async (input) => {
        const identity = deps.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
        const workspace = await executorCoordinator(env, identity, workspaceId);
        const waited = asRecord(await workspace.processWait({
          processId: text(input.process_id) as ProcessId,
          timeoutMs: Math.min(optionalNumber(input.timeout_ms) ?? 30_000, 30_000)
        }));
        if (waited.timedOut === true) {
          return { ...waited, remote_persisted: false, executor_filesystem: 'ephemeral' };
        }

        const process = waited.process && typeof waited.process === 'object'
          ? waited.process as Record<string, unknown>
          : {};
        const mutatesFilesystem = process.mutatesFilesystem === true;
        const exitCode = typeof process.exitCode === 'number' ? process.exitCode : undefined;
        if (!mutatesFilesystem) {
          return {
            ...waited,
            remote_persisted: false,
            executor_filesystem: 'ephemeral',
            next_step: durabilityNextStep('read_only')
          };
        }
        return {
          ...waited,
          remote_persisted: false,
          executor_filesystem: 'ephemeral',
          persistence_notice: durabilityNextStep('process_done'),
          next_step: exitCode === 0
            ? durabilityNextStep('process_done')
            : 'Inspect forge_process_logs. Any partial filesystem changes remain ephemeral; use forge_edit only for changes you deliberately want to save.'
        };
      },
      forge_deps_install: async (input) => {
        const identity = deps.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
        const coordinator = await executorCoordinator(env, identity, workspaceId);
        const result = await coordinator.dependenciesInstall({
          frozenLockfile: Boolean(input.frozen_lockfile),
          allowLockfileUpdate: Boolean(input.allow_lockfile_update),
          networkPolicy: text(input.network_policy) as never,
          timeoutMs: optionalNumber(input.timeout_ms) ?? 600_000,
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: idempotency(input.idempotency_key)
        });
        return asRecord({ ...result, remote_persisted: false, executor_filesystem: 'ephemeral' });
      },
      forge_deploy: async (input) => runEnvDrivenDeploy(env, deps, input, 'auto'),
      forge_cloudflare_deploy: async (input) => runEnvDrivenDeploy(env, deps, input, 'cloudflare_wrangler'),
      forge_preview_expose: async (input) => {
        const identity = deps.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input)) as WorkspaceId;
        const value = await (await executorCoordinator(env, identity, workspaceId)).previewExpose({
          processId: text(input.process_id) as ProcessId,
          port: number(input.port),
          hostname: env.FORGE_PREVIEW_HOSTNAME,
          access: text(input.access) as never,
          ttlSeconds: number(input.ttl_seconds),
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: idempotency(input.idempotency_key)
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
      forge_preview: async (input) => {
        const identity = deps.identity();
        // One deadline covers startup and capture. A 30s startup budget followed
        // by the old 110s capture budget still lost the whole response at the
        // host's ~60s transport boundary.
        const toolDeadlineAt = Date.now() + 45_000;
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input)) as WorkspaceId;
        // Getting here used to cost four calls and a polling loop: start the dev
        // server, poll its logs until it booted, expose a preview, then capture.
        // That is the whole "how does my app look right now" loop, and it is the
        // shape a chat session is worst at. With no preview_id, Forge does it â€”
        // detect the dev command, start it, wait for it to answer, expose it â€”
        // so screenshotting your own app is one call, same as a live URL.
        const workspace = await executorCoordinator(env, identity, workspaceId);
        let previewId = input.preview_id ? text(input.preview_id) : '';
        if (!previewId) {
          const deadline = Math.min(toolDeadlineAt - 10_000, Date.now() + number(input.preview_wait_ms));
          let lastReason = 'the dev server did not start in time';
          for (;;) {
            const remainingMs = Math.max(250, Math.min(5_000, deadline - Date.now()));
            const started = await withDeadline(
              workspace.startReviewPreview({
                hostname: env.FORGE_PREVIEW_HOSTNAME,
                ttlSeconds: 3600
              }) as unknown as Promise<{ ready: boolean; previewId?: string; reason?: string }>,
              remainingMs
            ).catch((error: unknown) => ({
              ready: false as const,
              reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown'
            })) ?? { ready: false as const, reason: 'the workspace did not answer before the startup observation deadline' };
            if (started.ready && started.previewId) {
              previewId = started.previewId;
              break;
            }
            lastReason = started.reason ?? 'the dev server did not become ready';
            // No dev server to run is terminal â€” waiting cannot conjure one.
            if (lastReason.includes('no dev server command') || Date.now() >= deadline) {
              throw new ForgeError({
                code: 'FORGE_PREVIEW_UNAVAILABLE',
                message: lastReason.includes('no dev server command')
                  ? 'No dev server command was detected for this project, so there is nothing to screenshot. If dependencies are missing call forge_deps_install and forge_process_wait first; otherwise start the server with forge_shell async:true, then call forge_preview again (omit preview_id). Do not open a second workspace.'
                  : `The preview was not ready inside this call's host-safe startup budget (${lastReason}). If node_modules is missing call forge_deps_install then forge_process_wait; otherwise check forge_process_logs and retry forge_preview without restarting an already-running server or opening a second workspace.`,
                retryable: true
              });
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
        const detail = await workspace.getPreviewInternal(previewId);
        if (new Date(detail.preview.expiresAt).getTime() <= Date.now()) {
          throw new ForgeError({
            code: 'FORGE_PREVIEW_UNAVAILABLE',
            message: 'This preview has expired. Call forge_preview again without a preview_id and Forge will bring a fresh one up.',
            retryable: true
          });
        }
        const artifacts = new R2ArtifactStore(env.ARTIFACTS);
        const browser = await selectBrowserProvider(env, artifacts, detail.workspace.tenantId);
        const captures = input.captures as Array<{ selection?: string; route: string; state: string; steps?: Array<{ kind: BrowserActionStep['kind']; selector?: string; value?: string; key?: string; text?: string; path?: string; timeout_ms?: number }> }>;
        const viewports = normalizeViewports(input.viewports);
        const deadlineAt = toolDeadlineAt;
        const cells = captures.flatMap((capture) => viewports.map((viewport) => ({ capture, viewport })));
        // Capture cells in parallel with per-cell error isolation, so one failed
        // route no longer throws away the whole packet (the old serial loop did).
        const captured = await mapWithConcurrency<{ capture: typeof captures[number]; viewport: typeof viewports[number] }, Record<string, unknown> | { failure: Record<string, unknown> }>(
          cells,
          REVIEW_CAPTURE_CONCURRENCY,
          async ({ capture, viewport }) => {
            try {
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
                fullPage: false,
                operationId: ids.operation(),
                repositoryCommit: detail.workspace.currentCommit,
                workspaceRevision: detail.workspace.revision,
                deadlineAt
              };
              // With steps, drive the interaction then capture (proves a flow);
              // without, a single static capture.
              const result = capture.steps && capture.steps.length > 0
                ? await browser.act({ ...browserInput, steps: toActionSteps(capture.steps) })
                : await browser.captureEvidence(browserInput);
              const { inline, ...screenshotRef } = result.screenshot;
              return {
                selection: capture.selection ?? capture.route,
                route: capture.route,
                environment: viewport.id,
                state: capture.state,
                requestedViewport: { width: viewport.width, height: viewport.height },
                observedViewport: { width: result.screenshot.width, height: result.screenshot.height },
                screenshot: screenshotRef,
                accessibility: result.accessibility,
                // Audit trail: the exact interaction this evidence proves, so a
                // Parallax reviewer can see what was actually done, not just the
                // resulting frame.
                executedSteps: capture.steps ?? null,
                inspected: false,
                limitations: [],
                // Transient capture bytes for prepareInlineImages / storeGallery;
                // stripped before structuredContent so base64 never reaches the model.
                _inline: inline
              };
            } catch (error) {
              return { failure: { route: capture.route, environment: viewport.id, reason: error instanceof Error ? error.message.slice(0, 500) : 'The capture failed for an unknown reason.' } };
            }
          }
        );
        const evidence = captured.filter((cell): cell is Record<string, unknown> => !('failure' in cell));
        const failures = captured.filter((cell): cell is { failure: Record<string, unknown> } => 'failure' in cell).map((cell) => cell.failure);
        if (evidence.length === 0) {
          throw new ForgeError({
            code: 'FORGE_PREVIEW_UNAVAILABLE',
            message: 'Could not capture any screenshots from the preview. Confirm the preview is still running, then retry.',
            retryable: true,
            details: { failures }
          });
        }
        const structureSummary = summarizeStructure(
          evidence as Array<{ accessibility?: { structure?: { findingCount?: number; countsByKind?: Record<string, number>; truncated?: boolean } }; route?: unknown; environment?: unknown }>
        );
        const capturedCells: Array<{ route: unknown; viewport: unknown; state: unknown; findingCount: number; inline?: { base64: string; contentType: string } }> = [];
        for (const cell of evidence) {
          const inline = cell._inline as { base64: string; contentType: string } | undefined;
          capturedCells.push({
            route: cell.route,
            viewport: cell.observedViewport ?? cell.requestedViewport,
            state: cell.state,
            findingCount: findingCountOf(cell),
            inline
          });
        }
        // This tool used to attach nothing at all: it stored every screenshot and
        // told the caller to fetch them back one at a time. For the flow this
        // exists to serve — looking at your own app while designing it — that
        // meant the model never saw a single image without a second call per
        // shot. Attach them, and hand over a page for the rest, same as the
        // live-URL path.
        const capturedAtIso = new Date().toISOString();
        const { chosen: inlineCells, omitted: omittedImages } = await prepareInlineImages(env, capturedCells);
        const captureContent: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
        for (const cell of inlineCells) {
          captureContent.push({ type: 'image', data: cell.inline!.base64, mimeType: cell.inline!.contentType });
        }
        const captureGalleryUrl = await storeGallery(
          env, identity, workspaceId, `preview of ${workspaceId}`, capturedAtIso, capturedCells
        );
        // Strip transient inline bytes so no base64 leaks into structuredContent.
        const fullEvidence = evidence.map(({ _inline: _drop, ...rest }) => rest);
        // Concise per-cell rows for structuredContent — no base64, no heavy
        // accessibility trees. Images travel as MCP content; the gallery URL
        // covers the rest.
        const evidenceCells = fullEvidence.map((cell) => ({
          selection: cell.selection,
          route: cell.route,
          environment: cell.environment,
          state: cell.state,
          requestedViewport: cell.requestedViewport,
          observedViewport: cell.observedViewport,
          findingCount: findingCountOf(cell),
          executedSteps: cell.executedSteps,
          inspected: cell.inspected
        }));
        const capturePacket = {
          schemaVersion: 1,
          provider: 'forge',
          executionMode: 'preview_review',
          workspaceId,
          repository: `${detail.workspace.repository.owner}/${detail.workspace.repository.name}`,
          commit: detail.workspace.currentCommit,
          workspaceRevision: detail.workspace.revision,
          capturedAt: new Date().toISOString(),
          previewId,
          requestedCaptures: cells.length,
          capturedCount: fullEvidence.length,
          evidence: evidenceCells,
          failures,
          structureSummary,
          limitations: [],
          galleryUrl: captureGalleryUrl,
          inlineImageCount: inlineCells.length,
          omittedImageCount: omittedImages,
          nextStep: [
            `Inspect the ${inlineCells.length} image(s) attached to this result — they are the evidence.`,
            omittedImages > 0 ? `${omittedImages} further capture(s) did not fit; fetch them with forge_artifact_get on evidence[].screenshot.artifactId.` : '',
            captureGalleryUrl ? `Give the human this link to see them all in a browser: ${captureGalleryUrl}` : '',
            'Then mark that evidence inspected in Parallax, resolving or explicitly accepting any structureSummary heading defects.'
          ].filter(Boolean).join(' ')
        };
        captureContent.unshift({
          type: 'text',
          text: `Captured ${evidence.length} screenshot(s) of the running app.${
            omittedImages > 0
              ? ` ${inlineCells.length} are attached here; ${omittedImages} more are stored.`
              : ' All are attached to this message.'
          }${captureGalleryUrl ? ` View them all in a browser: ${captureGalleryUrl}` : ''}`
        });
        return forgeToolResponse(capturePacket, captureContent);
      },

  };
}
