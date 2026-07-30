import {
  ForgeError,
  toForgeError,
  workspaceIdFromIdempotency,
  type OperationId,
  type CredentialProfileId,
  type ProjectId,
  type TenantId,
  type WorkspaceId
} from '@forge/core';
import { type ForgeToolHandlers, utf8Bytes } from '@forge/mcp-core';
import { verifyFeatureBranchOnOrigin } from '../merge-guards';
import { D1TaskStore } from '@forge/metadata-d1';
import { analyzeDiff, selectContext } from '@forge/insight';
import type { RepositoryRef } from '@forge/task-core';
import { workflowInstanceId } from '@forge/workflows-cloudflare';
import { assertForgeBranch, isAgentForgeBranch } from '@forge/policy';
import { resolveWorkspaceId, parseWorkspaceAddress, isWorkspaceId } from '../workspace-resolve';
import type { Env } from '../env';
import { workspaceOperations } from '../workspace-operations';
import { reserveWorkspaceSlot, releaseWorkspaceSlot, listSlotOccupants, slotTtlMs, workspaceCaps, TERMINAL_STATES } from '../capacity';
import { aiEnabled, summarizeDiffForPr } from '../ai';
import {
  authorizeRepository,
  listAuthorizedRepositories,
  repositoryWriteProof,
  requestApproval,
  githubRequestForWorkspace
} from '../github';
import { createDeferredAction } from '../deferred-actions';
import { commitFilesToBranch, createBranchRef, RemoteCommitConflict } from '@forge/git-github';
import { describeDurability } from '../durability';
import { normalizeRepoPath, toContainerPath } from '../repo-paths';
import { GitHubReadUnavailable, resolveBranchTree, readBlobFromTree, listEntriesFromTree } from '../github-reads';
import { applyReplacements, ReplacementFailed } from '../apply-replacements';
import { deleteGitHubBranchIfUnchanged, listGitHubBranchesWithinBudget, liveWorkspaceBranches } from '../github-branches';
import { readFragmentSource, readPullRequestReadiness } from '../github-repository';
import { forgeStartSlug } from '../forge-start-branch';
import {
  spillTextArtifact, withDeadline, authorizedCoordinator, text, number, optionalNumber,
  asRecord, workspaceAddress, recordTaskRemoteSha, idempotency,
  gitBlobSha, sha256
} from './helpers';
import type { RepositoryWorkspaceHandlerDependencies } from './types';

type WorkflowTool = 'forge_start' | 'forge_workspace_create' | 'forge_workspace_get' | 'forge_operation_get' | 'forge_files_list' | 'forge_files_read' | 'forge_edit' | 'forge_diff_metadata' | 'forge_context_get' | 'forge_pr' | 'forge_access' | 'forge_history' | 'forge_branches' | 'forge_merge' | 'forge_workspace_destroy';

/** Focused repositoryWorkspace workflows behind the ForgeToolHandlers seam. */
export function repositoryWorkspaceToolHandlers(env: Env, deps: RepositoryWorkspaceHandlerDependencies): Pick<ForgeToolHandlers, WorkflowTool> {
  return {
      forge_start: async (input) => {
        // Create the agent's branch on GitHub before any container exists, so
        // it is real on origin from the moment it exists at all. This is what
        // closes the gap forge_merge's push fallback used to paper over: a
        // branch cut only inside a container that never received a forge_edit
        // never reached origin, and forge_merge's only recourse was a force
        // push that 403'd at the very end of a session. Pass the returned
        // `branch` as `ref` to forge_workspace_create and it adopts this
        // branch instead of cutting a new one.
        const identity = deps.identity();
        const owner = text(input.owner);
        const repo = text(input.repo);
        const repository = { provider: 'github' as const, owner, name: repo };
        const request = await githubRequestForWorkspace(env, identity, { repository });

        let baseRef = input.base_ref === undefined ? '' : text(input.base_ref);
        if (!baseRef) {
          const repoInfo = await request(`/repos/${owner}/${repo}`);
          if (repoInfo.status !== 200) {
            throw new ForgeError({
              code: 'FORGE_PROVIDER_UNAVAILABLE',
              message: `GitHub returned HTTP ${repoInfo.status} reading ${owner}/${repo}, so Forge could not resolve its default branch. Pass base_ref explicitly, or check the repository name with forge_access.`,
              retryable: repoInfo.status >= 500
            });
          }
          baseRef = String((repoInfo.json as { default_branch?: string }).default_branch ?? 'main');
        }

        const baseRefRead = await request(
          `/repos/${owner}/${repo}/git/ref/heads/${baseRef.split('/').map(encodeURIComponent).join('/')}`
        );
        if (baseRefRead.status !== 200) {
          throw new ForgeError({
            code: 'FORGE_FILE_NOT_FOUND',
            message: `${baseRef} was not found in ${owner}/${repo} (HTTP ${baseRefRead.status}). Check the branch name, or call forge_branches to list what exists.`,
            retryable: false,
            details: { owner, repo, baseRef }
          });
        }
        const baseSha = (baseRefRead.json as { object?: { sha?: string } }).object?.sha;
        if (!baseSha) {
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: `GitHub returned ${baseRef} on ${owner}/${repo} with no commit sha attached. Try again, or pass a different base_ref.`,
            retryable: true
          });
        }

        // Same digest forge_workspace_create's own branch-cutting fallback
        // uses (scoped by tenant+project, SHA-256, first 16 hex characters),
        // so a slug this mints and one the fallback would have cut look
        // identical in form. An explicit slug is taken as-is; assertForgeBranch
        // below is what actually validates either one.
        const slug = input.slug !== undefined
          ? text(input.slug)
          : await forgeStartSlug({
            tenantId: identity.tenantId,
            projectId: identity.projectId,
            owner,
            repo,
            ...(input.idempotency_key === undefined ? {} : { idempotencyKey: text(input.idempotency_key) })
          });
        const branch = `forge/${slug}`;
        assertForgeBranch(branch);

        const creation = await createBranchRef(request, { owner, repo, branch, baseSha });

        return {
          owner,
          repo,
          branch,
          base_ref: baseRef,
          base_sha: baseSha,
          created: creation.created,
          next_step: `${branch} now exists on GitHub at ${baseSha}. Call forge_workspace_create with this repository and ref:'${branch}' — it will adopt this branch instead of cutting a new one, so it is already on origin when the workspace becomes ready.`
        };
      },
      forge_workspace_create: async (input) => {
        const identity = deps.identity();
        const credentialProfileId = await deps.selectedCredentialProfileId(identity);
        const repository = input.repository as { provider: 'github'; owner: string; name: string };
        const idempotencyKey = idempotency(input.idempotency_key);
        const workspaceId = await workspaceIdFromIdempotency(
          `${identity.tenantId}:${identity.projectId}`,
          idempotencyKey
        );
        const operationId = `op_${workspaceId.replace(/^ws_/u, '')}` as OperationId;
        // Claim a slot on the fast path with no reaper cost. Only if the claim
        // hits the quota do we reclaim stale slots (missing, terminal, or idle
        // past the TTL), tear those workspaces down, and retry once.
        const caps = workspaceCaps(env);
        try {
          await reserveWorkspaceSlot(env.METADATA, identity.tenantId, workspaceId, caps);
        } catch (reserveError) {
          if (reserveError instanceof ForgeError && reserveError.code === 'FORGE_QUOTA_EXCEEDED') {
            const freed = await deps.reclaimStaleWorkspaceSlots();
            if (freed === 0) throw reserveError;
            await reserveWorkspaceSlot(env.METADATA, identity.tenantId, workspaceId, caps);
          } else {
            throw reserveError;
          }
        }
        let workspaceRef = text(input.ref);
        try {
          // Installed repositories get a durable forge/* branch before any
          // executor exists. Public repositories without an installation can
          // still use the execution plane read-only; forge_edit remains
          // unavailable until the App is installed.
          const installation = await authorizeRepository(env, identity, repository);
          if (installation && !workspaceRef.startsWith('forge/')) {
            const request = await githubRequestForWorkspace(env, identity, { repository });
            const encodedRef = workspaceRef.split('/').map(encodeURIComponent).join('/');
            const base = await request(
              `/repos/${repository.owner}/${repository.name}/git/ref/heads/${encodedRef}`
            );
            const baseSha = base.status === 200
              ? (base.json as { object?: { sha?: string } }).object?.sha
              : undefined;
            if (!baseSha) {
              throw new ForgeError({
                code: base.status === 404 ? 'FORGE_FILE_NOT_FOUND' : 'FORGE_PROVIDER_UNAVAILABLE',
                message: `GitHub could not resolve branch ${workspaceRef} on ${repository.owner}/${repository.name} because GitHub returned HTTP ${base.status}. Nothing was provisioned; check the branch with forge_branches before retrying.`,
                retryable: base.status >= 500,
                details: { repository, ref: workspaceRef, status: base.status }
              });
            }
            const branch = `forge/${workspaceId.replace(/^ws_/u, '').slice(0, 16)}`;
            assertForgeBranch(branch);
            await createBranchRef(request, {
              owner: repository.owner,
              repo: repository.name,
              branch,
              baseSha
            });
            workspaceRef = branch;
          } else if (workspaceRef.startsWith('forge/')) {
            assertForgeBranch(workspaceRef);
          }
        } catch (error) {
          await releaseWorkspaceSlot(env.METADATA, workspaceId).catch(() => undefined);
          throw error;
        }
        const initializeWorkspace = workspaceOperations(env, workspaceId).initialize({
            workspaceId,
            operationId,
            tenantId: identity.tenantId as TenantId,
            projectId: identity.projectId as ProjectId,
            repository,
            agentBranch: workspaceRef,
            ref: text(input.ref),
            ...(credentialProfileId ? { credentialProfileId: credentialProfileId as CredentialProfileId } : {}),
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
        const quickInitialize = await Promise.race([
          initializeWorkspace.then(
            (value) => ({ status: 'initialized' as const, value }),
            (error) => ({ status: 'failed' as const, error })
          ),
          new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 2_000))
        ]);
        if (quickInitialize.status === 'pending') {
          const finishInitialization = initializeWorkspace.catch(async (error) => {
            await releaseWorkspaceSlot(env.METADATA, workspaceId).catch(() => undefined);
            console.warn('forge_workspace_initialize_failed_after_receipt', {
              workspaceId,
              reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown'
            });
          });
          (deps.ctx as unknown as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil?.(finishInitialization);
          return {
            workspace_id: workspaceId,
            state: 'requested',
            operation_id: operationId,
            workspace_revision: 1,
            current_branch: workspaceRef,
            next_step: `GitHub branch ${workspaceRef} is ready. Use forge_files_read and forge_edit now without a container. The first forge_shell or other execution tool will start the ephemeral executor.`
          };
        }
        if (quickInitialize.status === 'failed') {
          // A workspace-ID conflict means an existing live workspace already
          // holds this slot legitimately — releasing it would let the tenant
          // over-admit past its cap. Only release on genuine init failures.
          if (!(quickInitialize.error instanceof ForgeError && quickInitialize.error.code === 'FORGE_WORKSPACE_CONFLICT')) {
            await releaseWorkspaceSlot(env.METADATA, workspaceId);
          }
          throw quickInitialize.error;
        }
        const result = quickInitialize.value;
        if (['failed', 'destroyed'].includes(result.state)) {
          await releaseWorkspaceSlot(env.METADATA, workspaceId);
        }
        const state = result.state;
        // A failed workspace inside a successful tool result is the same lie as
        // an unpushed commit reported as saved: the field says failed, the
        // envelope says it worked, and agents read the envelope. One did exactly
        // that here — took the success, called forge_shell against a dead
        // workspace, met a bare "Workspace is failed.", and decided the GitHub
        // App was read-only. Fail the call, and carry the real reason.
        if (state === 'failed') {
          const failed = await withDeadline(
            workspaceOperations(env, workspaceId).getState({ compact: true }) as unknown as Promise<unknown>,
            1_000
          );
          const failure = failed && typeof failed === 'object' && 'failure' in failed
            ? (failed as { failure?: { stage?: string; code?: string; message?: string } }).failure
            : undefined;
          // Composed outside the message template on purpose: a nested
          // backtick literal in `message:` (this one had one, for the failure
          // detail) defeats invariants.test.ts's static message sweep, which
          // does not parse JS — it would see the fallback stage name
          // ('provision') as if it were the whole message. One flat template
          // with no nested backtick keeps the real message auditable.
          const failureDetail = failure?.message
            ? ` It failed at the ${failure.stage ?? 'provision'} stage: ${failure.message}.`
            : '';
          throw new ForgeError({
            code: 'FORGE_WORKSPACE_NOT_READY',
            message: `Workspace ${workspaceId} could not be provisioned.${failureDetail} This is a provisioning fault, not a repository permission problem — call forge_workspace_create again with the same owner/repo/branch; if it fails a second time, report that rather than working around it.`,
            retryable: true,
            details: {
              workspace_id: workspaceId,
              state,
              operation_id: result.operationId,
              ...(failure?.code ? { failure_code: failure.code } : {}),
              next_step: 'forge_workspace_create'
            }
          });
        }
        return {
          workspace_id: workspaceId,
          state,
          operation_id: result.operationId,
          workspace_revision: result.revision,
          current_branch: workspaceRef,
          executor_state: state === 'ready' ? 'ready' : 'not_loaded',
          next_step: state === 'ready'
            ? `GitHub branch ${workspaceRef} and the existing executor are ready. forge_edit saves directly to GitHub.`
            : `GitHub branch ${workspaceRef} is ready. Read and edit through GitHub now; the first execution tool will lazily start the ephemeral executor.`
        };
      },
      forge_workspace_get: async (input) => {
        const identity = deps.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)))).getState({
          compact: Boolean(input.compact)
        }));
      },
      forge_operation_get: async (input) => {
        const identity = deps.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)))).operationGet({
          operationId: text(input.operation_id) as OperationId
        }));
      },
      forge_files_list: async (input) => {
        const identity = deps.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)));
        const containerRoot = toContainerPath(text(input.path));
        const relativeRoot = normalizeRepoPath(text(input.path));
        const depth = number(input.depth);
        const limit = number(input.limit);
        try {
          const { tree } = await resolveBranchTree(env, identity, workspace);
          const { entries, truncated } = listEntriesFromTree(tree, relativeRoot, depth, limit);
          // Tell the model the listing was clipped so it narrows (deeper path,
          // higher limit) instead of assuming it saw the whole tree — or, when
          // GitHub's own tree read was itself incomplete, that narrowing the
          // path is the only thing that will actually help (raising limit
          // will not).
          const hint = truncated
            ? (tree.truncated
                ? 'GitHub could not return this repository\'s whole file tree in one call, so some entries are missing regardless of limit. Narrow with a deeper path.'
                : 'Listing truncated at the limit. Narrow with a deeper path or raise limit.')
            : undefined;
          return asRecord({ root: containerRoot, entries, truncated, source: 'github', ...(hint ? { hint } : {}) });
        } catch (error) {
          if (!(error instanceof GitHubReadUnavailable)) throw error;
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: 'GitHub is temporarily unavailable, so Forge cannot return an authoritative repository listing. The executor checkout is deliberately not used as a fallback. Retry the same call.',
            retryable: true,
            details: { reason: error.message, source: 'github' }
          });
        }
      },
      forge_files_read: async (input) => {
        const identity = deps.identity();
        const paths = (
          Array.isArray(input.paths) && input.paths.length > 0
            ? (input.paths as unknown[]).map((value) => text(value))
            : input.path !== undefined
              ? [text(input.path)]
              : []
        ).map((value) => normalizeRepoPath(value));
        if (paths.length === 0) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'Provide either path (one file) or a non-empty paths array (several) — forge_files_read needs at least one to know what to read.',
            retryable: false
          });
        }
        // Aggregate-work ceiling: the per-file max_bytes (up to 500KB) applied
        // across up to 20 paths would let a single call pull ~10MB into the
        // Worker. Cap the total requested bytes so the batch cannot be used to
        // amplify memory/CPU, independent of the per-file bound.
        const MAX_TOTAL_READ_BYTES = 2_000_000;
        const perFileMaxBytes = number(input.max_bytes);
        if (paths.length * perFileMaxBytes > MAX_TOTAL_READ_BYTES) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `This read exceeds the ${MAX_TOTAL_READ_BYTES}-byte aggregate limit (${paths.length} paths x ${perFileMaxBytes} bytes each). Reduce max_bytes, or read fewer paths and call forge_files_read again for the rest.`,
            retryable: false,
            details: { paths: paths.length, maxBytes: perFileMaxBytes, totalLimit: MAX_TOTAL_READ_BYTES }
          });
        }
        const readWorkspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
        const workspace = await authorizedCoordinator(env, identity, readWorkspaceId);
        const readOne = {
          startLine: optionalNumber(input.start_line),
          endLine: optionalNumber(input.end_line),
          maxBytes: perFileMaxBytes
        };
        const relativePaths = paths;
        // Only a complete read establishes what the agent saw; a range or a
        // truncated read must not license a whole-file overwrite.
        const isCompleteRead = readOne.startLine === undefined && readOne.endLine === undefined;

        let treeContext: Awaited<ReturnType<typeof resolveBranchTree>>;
        try {
          treeContext = await resolveBranchTree(env, identity, workspace);
        } catch (error) {
          if (!(error instanceof GitHubReadUnavailable)) throw error;
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: 'GitHub is temporarily unavailable, so Forge cannot return authoritative file content. The executor checkout is deliberately not used as a fallback. Retry the same call.',
            retryable: true,
            details: { reason: error.message, source: 'github' }
          });
        }

        const readOnePath = async (relativePath: string): Promise<Record<string, unknown>> => {
          try {
            const result = await readBlobFromTree(
              treeContext.request,
              treeContext.repository.owner,
              treeContext.repository.name,
              treeContext.tree,
              relativePath,
              readOne
            );
            if (isCompleteRead) {
              // The blob sha GitHub just reported for this exact path — not a
              // re-hash of decoded content, which is what this whole change
              // exists to stop being wrong on CRLF and binary files.
              await workspace.rememberReads({ entries: [{ path: relativePath, sha: result.blobSha }] });
            }
            return { path: relativePath, content: result.content, sizeBytes: result.sizeBytes, truncated: result.truncated, source: 'github' as const };
          } catch (error) {
            if (error instanceof GitHubReadUnavailable) {
              throw new ForgeError({
                code: 'FORGE_PROVIDER_UNAVAILABLE',
                message: `GitHub is temporarily unavailable, so Forge cannot return authoritative content for ${relativePath}. The executor checkout is deliberately not used as a fallback. Retry the same call.`,
                retryable: true,
                details: { path: relativePath, reason: error.message, source: 'github' }
              });
            }
            throw error;
          }
        };

        // Single path keeps the original flat shape; multiple returns a files
        // array with per-file errors so one missing file does not fail the batch.
        if (paths.length === 1) {
          return readOnePath(relativePaths[0] as string);
        }
        const files = await Promise.all(
          relativePaths.map(async (path) => {
            try {
              return await readOnePath(path);
            } catch (error) {
              // Surface a real ForgeErrorCode so an agent keying on codes never
              // meets an undocumented one.
              return { path, error: toForgeError(error).code, message: error instanceof Error ? error.message.slice(0, 300) : 'The read failed for an unknown reason.' };
            }
          })
        );
        return { files };
      },
      forge_edit: async (input) => {
        const identity = deps.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
        const workspace = await authorizedCoordinator(env, identity, workspaceId);
        const state = await withDeadline(
          (async () => (await workspace.getAuthorizationBinding()) as { repository: RepositoryRef; requestedRef: string; currentBranch?: string; baseCommit?: string; currentCommit?: string })(),
          15_000
        );
        if (!state) {
          throw new ForgeError({
            code: 'FORGE_WORKSPACE_NOT_READY',
            message: 'The workspace did not respond in time, so Forge cannot tell which branch to commit to. Nothing was written. Retry the same call.',
            retryable: true,
            details: { workspaceId }
          });
        }
        const branch = state.currentBranch ?? state.requestedRef;
        if (!branch || !isAgentForgeBranch(branch)) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'This workspace has no agent branch to edit. Create the workspace through forge_workspace_create, which cuts one for you.',
            retryable: false
          });
        }
        const requested = (input.files as Array<{ path: string; content?: string | null; replace?: Array<{ old: string; new: string; all?: boolean }> }>).map((file) => ({
          path: normalizeRepoPath(text(file.path)),
          content: file.content === undefined ? undefined : file.content === null ? null : text(file.content),
          replace: file.replace
        }));
        for (const file of requested) {
          const hasContent = file.content !== undefined;
          const hasReplace = Array.isArray(file.replace) && file.replace.length > 0;
          if (hasContent === hasReplace) {
            throw new ForgeError({
              code: 'FORGE_VALIDATION_FAILED',
              message: `${file.path}: send either content (whole file, or null to delete) or replace (fragments), not both and not neither.`,
              retryable: false
            });
          }
        }
        const duplicate = requested.map((f) => f.path).find((path, index, all) => all.indexOf(path) !== index);
        if (duplicate) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `"${duplicate}" appears twice in one edit. Send each path once — the last write would silently win.`,
            retryable: false
          });
        }
        const message = input.message === undefined
          ? `edit: ${requested.length} file${requested.length === 1 ? '' : 's'}`
          : text(input.message);
        const editIdempotencyKey = input.idempotency_key === undefined
          ? undefined
          : text(input.idempotency_key);
        const editIntentHash = await sha256(JSON.stringify({ requested, message }));
        if (editIdempotencyKey) {
          const replay = await workspace.remoteMutationReplay({
            kind: 'edit',
            idempotencyKey: editIdempotencyKey,
            intentHash: editIntentHash
          });
          if (replay && typeof replay === 'object') return { ...(replay as Record<string, unknown>), replayed: true };
        }

        const request = await githubRequestForWorkspace(env, identity, { repository: state.repository });
        // Fragment edits are resolved here, against what the file actually
        // contains right now. Forge does the reading, so the agent never has
        // to re-emit a whole file and cannot lose the parts it did not send.
        const resolvedBlobs: Record<string, string> = {};
        const files: Array<{ path: string; content: string | null }> = [];
        for (const file of requested) {
          if (file.content !== undefined) {
            files.push({ path: file.path, content: file.content });
            continue;
          }
          const source = await readFragmentSource(request, {
            base: `/repos/${state.repository.owner}/${state.repository.name}`,
            branch,
            baseSha: state.baseCommit ?? state.currentCommit,
            path: file.path
          });
          if (!source.ok) {
            if (source.kind === 'base_unavailable') {
              throw new ForgeError({
                code: 'FORGE_WORKSPACE_NOT_READY',
                message: `${branch} is not on GitHub yet and the workspace has no base commit recorded, so Forge cannot safely resolve ${file.path}. Nothing was written; retry after the workspace is ready.`,
                retryable: true,
                details: { path: file.path, branch, cause: 'branch_absent_no_base' }
              });
            }
            if (source.kind === 'file_missing') {
              const missingFrom = source.branchMissing
                ? `base commit ${source.sourceRef}`
                : branch;
              throw new ForgeError({
                code: 'FORGE_FILE_NOT_FOUND',
                message: `${file.path} cannot be fragment-edited because it does not exist on ${missingFrom}. Use whole-file content to create it instead.`,
                retryable: false,
                details: { path: file.path, branch, sourceRef: source.sourceRef, cause: source.branchMissing ? 'file_absent_at_base' : 'file_absent' }
              });
            }
            const transient = source.status === 429 || source.status >= 500;
            throw new ForgeError({
              code: transient ? 'FORGE_PROVIDER_UNAVAILABLE' : 'FORGE_PERMISSION_DENIED',
              message: transient
                ? `GitHub returned HTTP ${source.status} resolving ${file.path} from ${source.sourceRef}, which is a transient fault rather than anything about the file. Retry the same edit.`
                : `GitHub returned HTTP ${source.status} resolving ${file.path} from ${source.sourceRef}. This is an access problem, not a missing file — call forge_access for this repository, and do not send whole-file content, which would overwrite what is really there.`,
              retryable: transient,
              details: { path: file.path, branch, status: source.status, operation: source.operation }
            });
          }
          const body = source.body;
          if (typeof body.content !== 'string' || typeof body.sha !== 'string') {
            throw new ForgeError({
              code: 'FORGE_FILE_CONFLICT',
              message: `${file.path} could not be read as text, so fragment replacement cannot be applied to it.`,
              retryable: false,
              details: { path: file.path }
            });
          }
          const currentText = new TextDecoder().decode(
            Uint8Array.from(atob(body.content.replace(/\n/gu, '')), (character) => character.charCodeAt(0))
          );
          try {
            files.push({ path: file.path, content: applyReplacements(file.path, currentText, file.replace!) });
          } catch (error) {
            if (error instanceof ReplacementFailed) {
              throw new ForgeError({
                code: 'FORGE_FILE_CONFLICT',
                message: error.message,
                retryable: false,
                details: { path: error.path, reason: error.reason }
              });
            }
            throw error;
          }
          // Forge read it, so the read-before-overwrite guard is satisfied by
          // the blob it actually applied the change to.
          resolvedBlobs[file.path] = body.sha;
        }
        const editGate = await workspace.beginGitHubEdit({ branch, intentHash: editIntentHash });
        let result;
        try {
          result = await commitFilesToBranch(request, {
            owner: state.repository.owner,
            repo: state.repository.name,
            branch,
            message,
            files,
            expectedBlobs: { ...(await workspace.seenBlobs({ paths: files.map((file) => file.path) })), ...resolvedBlobs },
            // Legacy workspaces may still need the branch created from their
            // recorded base; current workspaces create it on GitHub up front.
            baseSha: state.baseCommit ?? state.currentCommit,
            requireKnownBase: true
          });
        } catch (error) {
          if (error instanceof RemoteCommitConflict) {
            await workspace.cancelGitHubEdit({ token: editGate.token }).catch(() => undefined);
            throw new ForgeError({
              code: 'FORGE_FILE_CONFLICT',
              message: error.message,
              retryable: false,
              details: { conflictingPaths: error.conflictingPaths, branch }
            });
          }
          throw error;
        }

        // GitHub has accepted this commit before the call returns, so the
        // durability receipt is final.
        const verdict = describeDurability({
          branch,
          commit: result.commitSha ?? result.parentSha,
          remoteSha: result.remoteSha,
          committed: !result.unchanged
        });
        if (result.commitSha) {
          await recordTaskRemoteSha(env, workspaceId as WorkspaceId, result.commitSha);
        }
        const recordInput = {
          token: editGate.token,
          commit: result.remoteSha,
          branch,
          invalidateDependencies: result.paths.some((path) => /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|pyproject\.toml|uv\.lock|requirements\.txt)$/u.test(path))
        };
        let executorSync: { executorSynced: boolean; recorded: boolean } = {
          executorSynced: false,
          recorded: false
        };
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const recorded = await workspace.recordGitHubCommit(recordInput);
            executorSync = { executorSynced: recorded.executorSynced, recorded: true };
            break;
          } catch {
            // The RPC is idempotent by edit token. Retry a lost response instead
            // of leaving a durable GitHub commit with no executor gate.
          }
        }
        // What we just wrote is now what is on the branch, so a second edit to
        // the same path does not need an intervening read.
        await workspace.forgetReads({ paths: files.filter((file) => file.content === null).map((file) => file.path) });
        await workspace.rememberReads({
          entries: await Promise.all(
            files
              .filter((file) => file.content !== null)
              .map(async (file) => ({ path: file.path, sha: await gitBlobSha(file.content as string) }))
          )
        });
        const receipt = {
          ...verdict,
          ...(result.commitSha ? { commit_sha: result.commitSha } : {}),
          ...(result.commitSha
            ? { commit_url: `https://github.com/${state.repository.owner}/${state.repository.name}/commit/${result.commitSha}` }
            : {}),
          branch,
          paths: result.paths,
          rebased: result.rebased,
          executor_synced: executorSync.executorSynced,
          executor_sync_recorded: executorSync.recorded,
          next_step: !executorSync.recorded
            ? `Committed and verified on GitHub at ${result.remoteSha}, but Forge could not confirm the workspace handoff. Do not run executor commands in this workspace. Call forge_workspace_destroy, then forge_workspace_create on ${branch}.`
            : result.unchanged
            ? 'Nothing changed — the files already had this content. Continue or call forge_merge.'
            : executorSync.executorSynced
              ? `Committed to GitHub and synchronized the loaded executor to ${result.remoteSha}. Run checks with forge_shell, then forge_merge when ready.`
              : `Committed to GitHub. The loaded executor will synchronize to ${result.remoteSha} before the next execution tool runs; call forge_process_wait or forge_process_stop for any active mutating process first.`
        };
        if (editIdempotencyKey && executorSync.recorded) {
          await workspace.recordRemoteMutation({
            kind: 'edit',
            idempotencyKey: editIdempotencyKey,
            intentHash: editIntentHash,
            receipt
          }).catch(() => undefined);
        }
        return receipt;
      },
      forge_diff_metadata: async (input) => {
        const identity = deps.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)));
        const binding = await workspace.getAuthorizationBinding();
        const branch = binding.currentBranch ?? binding.requestedRef;
        const base = input.base === undefined ? binding.requestedRef : text(input.base);
        const request = await githubRequestForWorkspace(env, identity, { repository: binding.repository });
        const comparison = await request(
          `/repos/${binding.repository.owner}/${binding.repository.name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`
        );
        if (comparison.status !== 200) {
          throw new ForgeError({
            code: comparison.status === 404 ? 'FORGE_FILE_NOT_FOUND' : 'FORGE_PROVIDER_UNAVAILABLE',
            message: `GitHub could not compare ${base}...${branch} because GitHub returned HTTP ${comparison.status}. No executor fallback was used; check both branches with forge_branches before retrying.`,
            retryable: comparison.status >= 500,
            details: { base, branch, status: comparison.status, source: 'github' }
          });
        }
        const body = comparison.json as {
          status?: string;
          ahead_by?: number;
          behind_by?: number;
          total_commits?: number;
          files?: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
        };
        const diff = (body.files ?? []).map((file) => [
          `diff --git a/${file.filename} b/${file.filename}`,
          `--- a/${file.filename}`,
          `+++ b/${file.filename}`,
          file.patch ?? `Binary or oversized ${file.status} file (${file.additions} additions, ${file.deletions} deletions)`
        ].join('\n')).join('\n');
        return asRecord({
          ...analyzeDiff(diff),
          source: 'github',
          base,
          head: branch,
          status: body.status ?? 'unknown',
          ahead_by: body.ahead_by ?? 0,
          behind_by: body.behind_by ?? 0,
          commits: body.total_commits ?? 0
        });
      },
      forge_context_get: async (input) => {
        const identity = deps.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)));
        let files: string[];
        try {
          const { tree } = await resolveBranchTree(env, identity, workspace);
          files = tree.entries
            .filter((entry) => entry.type === 'blob' && entry.path && !entry.path.startsWith('.'))
            .slice(0, 10_000)
            .map((entry) => entry.path);
        } catch (error) {
          if (!(error instanceof GitHubReadUnavailable)) throw error;
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: 'GitHub is temporarily unavailable, so Forge cannot select authoritative repository context. The executor checkout is deliberately not used as a fallback. Retry the same call.',
            retryable: true,
            details: { reason: error.message, source: 'github' }
          });
        }
        const response = selectContext({
          goal: text(input.goal),
          files,
          likelyPaths: (input.likely_paths as string[] | undefined) ?? [],
          maxResults: number(input.max_results)
        });
        return asRecord(response);
      },
      forge_pr: async (input) => {
        const identity = deps.identity();
        const owner = text(input.owner);
        const repo = text(input.repo);
        const request = await githubRequestForWorkspace(env, identity, { repository: { provider: 'github' as const, owner, name: repo } });
        const base = `/repos/${owner}/${repo}`;

        if (input.action === undefined || input.action === 'list') {
          const listed = await request(`${base}/pulls?state=open&per_page=50`);
          if (listed.status !== 200) {
            throw new ForgeError({ code: 'FORGE_PROVIDER_UNAVAILABLE', message: `GitHub returned HTTP ${listed.status} listing pull requests.`, retryable: true });
          }
          const pulls = (listed.json as Array<{ number: number; title: string; head: { ref: string }; base: { ref: string }; draft?: boolean; html_url: string }>).map((pr) => ({
            number: pr.number, title: pr.title, head: pr.head.ref, base: pr.base.ref, draft: pr.draft === true, url: pr.html_url
          }));
          return {
            repository: `${owner}/${repo}`,
            pull_requests: pulls,
            next_step: pulls.length
              ? `${pulls.length} open. Call action:'status' with a number before merging — it reports whether merging is actually safe.`
              : 'No open pull requests.'
          };
        }

        const number = input.number === undefined ? undefined : Number(input.number);
        if (!number) {
          throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: `action:'${text(input.action)}' needs a pull request number. Call action:'list' first.`, retryable: false });
        }

        // Always read fresh. A status an agent read earlier describes the head
        // it saw then; merging on it would merge commits nobody assessed.
        const readStatus = async () => {
          try {
            return await readPullRequestReadiness(request, base, number);
          } catch (error) {
            throw new ForgeError({
              code: 'FORGE_PROVIDER_UNAVAILABLE',
              message: error instanceof Error ? error.message : `GitHub could not read pull request #${number}.`,
              retryable: true,
              details: { owner, repo, number }
            });
          }
        };

        if (input.action === 'status') {
          const status = await readStatus();
          const { merge_commit_sha: _mergeCommitSha, ...publicStatus } = status;
          return {
            repository: `${owner}/${repo}`,
            status: publicStatus,
            next_step: status.safe_to_merge
              ? `#${number} is safe to merge at ${status.head_sha.slice(0, 12)}. Ask the human, then action:'merge'.`
              : `#${number} is NOT safe to merge: ${status.blockers.join(' ')}`
          };
        }

        if (input.action === 'close') {
          const status = await readStatus();
          if (input.expected_head_sha !== undefined && text(input.expected_head_sha) !== status.head_sha) {
            throw new ForgeError({
              code: 'FORGE_WORKSPACE_CONFLICT',
              message: `Pull request #${number} moved to ${status.head_sha}, so Forge refused to close the head ${text(input.expected_head_sha)} you assessed. Read status again, then retry with the new expected_head_sha.`,
              retryable: false,
              details: { number, expected_head_sha: text(input.expected_head_sha), current_head_sha: status.head_sha }
            });
          }
          if (status.state === 'closed' || status.already_merged) {
            return { repository: `${owner}/${repo}`, closed: true, next_step: `Pull request #${number} is already closed; this retry changed nothing.` };
          }
          const mutationKey = input.idempotency_key === undefined ? undefined : text(input.idempotency_key);
          const approvalPayload = { action: 'close', owner, repo, number, headSha: status.head_sha };
          return deps.runApprovedPullRequestMutation({
            identity, owner, repo, number, action: 'close',
            idempotencyKey: mutationKey,
            intent: { action: 'close', owner: owner.toLowerCase(), repo: repo.toLowerCase(), number, head: status.head_sha },
            approvalPayload,
            approvalId: input.approval_id === undefined ? undefined : text(input.approval_id),
            execute: async () => {
              const closed = await request(`${base}/pulls/${number}`, { method: 'PATCH', body: { state: 'closed' } });
              if (closed.status !== 200) {
                throw new ForgeError({ code: 'FORGE_PROVIDER_UNAVAILABLE', message: `GitHub returned HTTP ${closed.status} closing #${number}; retry the same call because Forge did not receive a closing receipt.`, retryable: true });
              }
              const closedReadBack = await request(`${base}/pulls/${number}`);
              const closedState = closedReadBack.status === 200
                ? String((closedReadBack.json as { state?: string }).state ?? '')
                : '';
              if (closedState !== 'closed') {
                throw new ForgeError({
                  code: 'FORGE_PROVIDER_UNAVAILABLE',
                  message: `GitHub accepted closing #${number}, but the provider read-back did not report closed (HTTP ${closedReadBack.status}). Retry the same idempotent call before claiming success.`,
                  retryable: true
                });
              }
              return { repository: `${owner}/${repo}`, closed: true, next_step: `Closed #${number} without merging.` };
            }
          });
        }

        const status = await readStatus();
        if (status.already_merged) {
          return {
            repository: `${owner}/${repo}`,
            merged: true,
            merge_sha: status.merge_commit_sha ?? '',
            next_step: `Pull request #${number} is already merged; this retry changed nothing.`
          };
        }
        if (input.expected_head_sha !== undefined && text(input.expected_head_sha) !== status.head_sha) {
          throw new ForgeError({
            code: 'FORGE_WORKSPACE_CONFLICT',
            message: `Pull request #${number} moved to ${status.head_sha}, so Forge refused to merge the head ${text(input.expected_head_sha)} you assessed. Read status again, then retry with the new expected_head_sha.`,
            retryable: false,
            details: { number, expected_head_sha: text(input.expected_head_sha), current_head_sha: status.head_sha }
          });
        }
        if (!status.safe_to_merge && input.force !== true) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `#${number} is not safe to merge: ${status.blockers.join(' ')} Nothing was merged. Fix these, or pass force:true with a reason to merge anyway.`,
            retryable: false,
            details: { number, blockers: status.blockers, head_sha: status.head_sha }
          });
        }
        if (!status.safe_to_merge && !input.reason) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'force:true requires a reason, so the record says why a pull request was merged past its own blockers.',
            retryable: false,
            details: { number, blockers: status.blockers }
          });
        }
        const mergeMethod = input.merge_method === undefined ? 'merge' : text(input.merge_method);
        const mutationKey = input.idempotency_key === undefined ? undefined : text(input.idempotency_key);
        const approvalPayload = {
          action: 'merge', owner, repo, number, headSha: status.head_sha, mergeMethod,
          force: input.force === true,
          reason: input.reason === undefined ? null : text(input.reason)
        };
        return deps.runApprovedPullRequestMutation({
          identity, owner, repo, number, action: 'merge',
          idempotencyKey: mutationKey,
          intent: { action: 'merge', owner: owner.toLowerCase(), repo: repo.toLowerCase(), number, head: status.head_sha, mergeMethod, force: input.force === true, reason: input.reason === undefined ? null : text(input.reason) },
          approvalPayload,
          approvalId: input.approval_id === undefined ? undefined : text(input.approval_id),
          execute: async () => {
            const merged = await request(`${base}/pulls/${number}/merge`, {
              method: 'PUT',
              body: { merge_method: mergeMethod, sha: status.head_sha }
            });
            if (merged.status !== 200) {
              throw new ForgeError({
                code: 'FORGE_PROVIDER_UNAVAILABLE',
                message: `GitHub refused the merge of #${number} with HTTP ${merged.status}; retry the same call because Forge did not receive a merge receipt.`,
                retryable: merged.status >= 500,
                details: { number, head_sha: status.head_sha }
              });
            }
            const mergedReadBack = await readStatus();
            if (!mergedReadBack.already_merged) {
              throw new ForgeError({
                code: 'FORGE_PROVIDER_UNAVAILABLE',
                message: `GitHub accepted merging #${number}, but the provider read-back did not report it merged. Retry the same idempotent call before claiming success.`,
                retryable: true,
                details: { number, head_sha: status.head_sha }
              });
            }
            return {
              repository: `${owner}/${repo}`,
              merged: true,
              merge_sha: mergedReadBack.merge_commit_sha ?? String((merged.json as { sha?: string }).sha ?? ''),
              next_step: `Merged #${number}. Delete the branch with forge_branches if it is no longer needed.`
            };
          }
        });
      },
      forge_access: async (input) => {
        const identity = deps.identity();
        const rows = await listAuthorizedRepositories(env, identity.tenantId);
        const authorized = rows.map((row) => `${String(row.owner)}/${String(row.name)}`);
        if (input.owner === undefined || input.repo === undefined) {
          return {
            authorized_repositories: authorized,
            next_step: authorized.length
              ? `Forge can reach ${authorized.length} repositor(y/ies). Pass owner and repo to check one specifically.`
              : 'No repositories are authorized. Install the Forge GitHub App and grant it the repositories you want.'
          };
        }
        const owner = text(input.owner);
        const repo = text(input.repo);
        const checked = `${owner}/${repo}`;
        if (!authorized.some((entry) => entry.toLowerCase() === checked.toLowerCase())) {
          return {
            authorized_repositories: authorized,
            checked,
            authorized: false,
            can_read: false,
            can_write: false,
            reason: `${checked} is not in this account's authorized repositories.`,
            next_step: `Install or grant the Forge GitHub App access to ${checked}. This is an installation problem, not a Git transport problem — retrying a push will not fix it.`
          };
        }
        // Authorized in Forge's records is not the same as reachable now, so
        // prove it against GitHub rather than reporting the row.
        const request = await githubRequestForWorkspace(env, identity, { repository: { provider: 'github' as const, owner, name: repo } }).catch(() => undefined);
        if (!request) {
          return { authorized_repositories: authorized, checked, authorized: true, can_read: false, can_write: false, reason: 'Forge could not mint an installation token for this repository.', next_step: `Re-install the Forge GitHub App for ${checked}.` };
        }
        const info = await request(`/repos/${owner}/${repo}`);
        // Write capability comes from the permissions GitHub grants the token,
        // never from the repository object: fetched with an installation token
        // it carries no `permissions` field at all, so reading `permissions.push`
        // reported can_write:false for every repository regardless of the truth.
        // That is what sent agents troubleshooting a permission problem that did
        // not exist, and told users to grant access they had already granted.
        const proof = await repositoryWriteProof(env, identity, { provider: 'github' as const, owner, name: repo });
        const canWrite = proof.authorized === true && proof.can_write;
        const canRead = info.status === 200;
        return {
          authorized_repositories: authorized,
          checked,
          authorized: true,
          can_read: canRead,
          can_write: canWrite,
          ...(proof.authorized === true && Object.keys(proof.permissions).length > 0
            ? { granted_permissions: proof.permissions }
            : {}),
          ...(canRead ? { default_branch: String((info.json as { default_branch?: string }).default_branch ?? 'main') } : {}),
          ...(canRead
            ? proof.authorized === true && proof.reason
              ? { reason: proof.reason }
              : {}
            : { reason: `GitHub returned HTTP ${info.status} for ${checked}.` }),
          next_step: !canRead
            ? `Forge cannot read ${checked} (HTTP ${info.status}). Check the App installation before assuming a transport fault.`
            : canWrite
              ? `Forge can read and write ${checked}. A failed edit, push or merge here is NOT a permission problem — read that tool's own error instead of re-checking access.`
              : `Forge can read ${checked} but GitHub refused a write-scoped token. Grant the Forge GitHub App contents:write on ${checked}.`
        };
      },
      forge_history: async (input) => {
        const identity = deps.identity();
        const owner = text(input.owner);
        const repo = text(input.repo);
        const request = await githubRequestForWorkspace(env, identity, { repository: { provider: 'github' as const, owner, name: repo } });
        const limit = input.limit === undefined ? 20 : Number(input.limit);
        const query = new URLSearchParams({ per_page: String(Math.min(Math.max(limit, 1), 50)) });
        if (input.ref !== undefined) query.set('sha', text(input.ref));
        if (input.path !== undefined) query.set('path', normalizeRepoPath(text(input.path)));
        const listed = await request(`/repos/${owner}/${repo}/commits?${query.toString()}`);
        if (listed.status !== 200) {
          throw new ForgeError({
            code: listed.status === 404 ? 'FORGE_FILE_NOT_FOUND' : 'FORGE_PROVIDER_UNAVAILABLE',
            message: input.path === undefined
              ? `GitHub returned HTTP ${listed.status} reading history for ${owner}/${repo}.`
              : `No history for ${text(input.path)} on ${input.ref === undefined ? 'the default branch' : text(input.ref)} (HTTP ${listed.status}). Check the path.`,
            retryable: listed.status >= 500
          });
        }
        const commits = (listed.json as Array<{ sha: string; html_url: string; commit: { message: string; author?: { name?: string; date?: string } } }>).map((entry) => ({
          sha: entry.sha,
          message: entry.commit.message.split('\n')[0] ?? '',
          author: entry.commit.author?.name ?? 'unknown',
          date: entry.commit.author?.date ?? '',
          url: entry.html_url
        }));
        return {
          repository: `${owner}/${repo}`,
          ref: input.ref === undefined ? 'default' : text(input.ref),
          ...(input.path === undefined ? {} : { path: normalizeRepoPath(text(input.path)) }),
          commits,
          returned: commits.length,
          next_step: commits.length
            ? `${commits.length} commit(s). Read any file at a commit with forge_files_read, or open a URL above.`
            : 'No commits matched.'
        };
      },
      forge_branches: async (input) => {
        const identity = deps.identity();
        const owner = text(input.owner);
        const repo = text(input.repo);
        const repository = { provider: 'github' as const, owner, name: repo };
        const request = await githubRequestForWorkspace(env, identity, { repository });
        const base = `/repos/${owner}/${repo}`;
        const branchToolDeadline = Date.now() + 45_000;

        const repoInfo = await request(base);
        if (repoInfo.status !== 200) {
          throw new ForgeError({
            code: 'FORGE_PERMISSION_DENIED',
            message: `Forge cannot read ${owner}/${repo}. Install and authorize the Forge GitHub App for it.`,
            retryable: false
          });
        }
        const defaultBranch = String((repoInfo.json as { default_branch?: string }).default_branch ?? 'main');

        let raw;
        let paginationTruncated = false;
        try {
          const listed = await listGitHubBranchesWithinBudget(request, base, Math.min(branchToolDeadline, Date.now() + 10_000));
          raw = listed.branches;
          paginationTruncated = listed.truncated;
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'GitHub returned an unreadable branch-list response';
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: `Forge could not list branches for ${owner}/${repo} because ${reason}. Retry the same call; no branch was changed.`,
            retryable: true
          });
        }

        // "Merged" is decided by asking GitHub whether the default branch
        // already contains the tip, never by the branch's name or age. A
        // deletion that guessed would be unrecoverable.
        const comparisonDeadline = branchToolDeadline;
        const branchCandidates = input.action === 'delete' && input.merged_only !== true && input.branch !== undefined
          ? raw.filter((entry) => entry.name === defaultBranch || entry.name === text(input.branch))
          : raw;
        const branches: Array<{ name: string; sha: string; merged: boolean; is_default: boolean; protected: boolean }> = [];
        let comparisonTruncated = paginationTruncated;
        for (let offset = 0; offset < branchCandidates.length; offset += 8) {
          if (Date.now() >= comparisonDeadline) {
            comparisonTruncated = true;
            break;
          }
          const batch = branchCandidates.slice(offset, offset + 8);
          const comparedBatch = await Promise.all(batch.map(async (entry) => {
            const isDefault = entry.name === defaultBranch;
            if (isDefault) return { name: entry.name, sha: entry.commit.sha, merged: true, is_default: true, protected: entry.protected === true };
            const compared = await withDeadline(
              request(`${base}/compare/${encodeURIComponent(defaultBranch)}...${entry.name.split('/').map(encodeURIComponent).join('/')}`),
              Math.max(250, Math.min(5_000, comparisonDeadline - Date.now()))
            );
            if (!compared || compared.status !== 200) return undefined;
            const status = (compared.json as { status?: string }).status;
            // behind or identical => everything on it is already in default.
            return {
              name: entry.name,
              sha: entry.commit.sha,
              merged: status === 'behind' || status === 'identical',
              is_default: false,
              protected: entry.protected === true
            };
          }));
          branches.push(...comparedBatch.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined));
          if (comparedBatch.some((entry) => entry === undefined)) comparisonTruncated = true;
        }
        if (branches.length < branchCandidates.length) comparisonTruncated = true;

        if (input.action !== 'delete') {
          const mergedCount = branches.filter((entry) => entry.merged && !entry.is_default).length;
          return {
            repository: `${owner}/${repo}`,
            default_branch: defaultBranch,
            branches: branches.map(({ protected: _p, ...rest }) => rest),
            truncated: comparisonTruncated,
            next_step: comparisonTruncated
              ? `Returned ${branches.length} branches whose merge state GitHub proved inside the host-safe budget. Retry to reassess omitted branches; do not infer that an omitted branch is unmerged.`
              : mergedCount
              ? `${mergedCount} branch(es) are already merged into ${defaultBranch}. Delete them with action:'delete', merged_only:true.`
              : `Nothing is safely deletable — no branch other than ${defaultBranch} is fully merged.`
          };
        }

        if (comparisonTruncated && input.merged_only === true) {
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: 'Forge could not prove the merge state of the complete branch set inside one host-safe call, so merged_only cleanup deleted nothing. Retry the same call later or delete one named branch from a complete list.',
            retryable: true
          });
        }
        if (paginationTruncated && input.branch !== undefined && !raw.some((entry) => entry.name === text(input.branch))) {
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: `Forge could not finish listing branches before the host-safe deadline, so it cannot prove that ${text(input.branch)} is absent and deleted nothing. Retry the same call later.`,
            retryable: true
          });
        }
        if (input.branch !== undefined && raw.some((entry) => entry.name === text(input.branch)) && !branches.some((entry) => entry.name === text(input.branch))) {
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: `Forge found ${text(input.branch)} but could not prove its current merge state, so it deleted nothing. Retry the same call later.`,
            retryable: true
          });
        }

        if (input.expected_sha !== undefined && input.merged_only === true) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'This call is invalid because expected_sha can guard only one named branch, while merged_only:true selects a batch. Remove expected_sha for the batch, or pass one branch with its expected_sha.',
            retryable: false
          });
        }

        const wanted = input.merged_only === true
          ? branches.filter((entry) => entry.merged && !entry.is_default)
          : branches.filter((entry) => entry.name === (input.branch === undefined ? '' : text(input.branch)));
        if (!wanted.length) {
          if (input.merged_only === true) {
            return {
              repository: `${owner}/${repo}`,
              default_branch: defaultBranch,
              deleted: [],
              already_absent: [],
              refused: [],
              next_step: `No merged branches currently exist to delete in ${owner}/${repo}; this call deleted nothing.`
            };
          }
          if (input.idempotency_key !== undefined && input.branch !== undefined) {
            return {
              repository: `${owner}/${repo}`,
              default_branch: defaultBranch,
              deleted: [],
              already_absent: [text(input.branch)],
              refused: [],
              next_step: `${text(input.branch)} is already absent from GitHub; this call did not delete it.`
            };
          }
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `Forge cannot delete ${input.branch === undefined ? '(no branch supplied)' : text(input.branch)} because that branch does not exist in ${owner}/${repo}. Call forge_branches with action:'list' and choose a returned branch; nothing was deleted.`,
            retryable: false
          });
        }

        // A remote branch can still be the live backing ref for a workspace.
        // Deleting it is destructive even when its current tip is merged.
        const occupants = await listSlotOccupants(env.METADATA, slotTtlMs(env));
        const liveBranches = liveWorkspaceBranches(occupants, owner, repo, TERMINAL_STATES);

        const deleted: string[] = [];
        const alreadyAbsent: string[] = [];
        const refused: Array<{ branch: string; reason: string }> = [];
        for (const entry of wanted) {
          // Three refusals that no flag overrides, because each one destroys
          // something that cannot be recovered from Forge.
          if (entry.is_default) {
            refused.push({ branch: entry.name, reason: `${entry.name} is the default branch.` });
            continue;
          }
          if (entry.protected) {
            refused.push({ branch: entry.name, reason: `${entry.name} is protected on GitHub.` });
            continue;
          }
          if (liveBranches.has(entry.name)) {
            refused.push({
              branch: entry.name,
              reason: `${entry.name} backs a live Forge workspace and cannot be deleted while that workspace is active. Destroy or move the workspace deliberately, then retry.`
            });
            continue;
          }
          if (!entry.merged && input.force !== true) {
            refused.push({
              branch: entry.name,
              reason: `${entry.name} has commits that are not on ${defaultBranch}; deleting it would lose them. Pass force:true with a reason if that is intended.`
            });
            continue;
          }
          if (!entry.merged && !input.reason) {
            refused.push({ branch: entry.name, reason: 'force:true requires a reason, so the record says why unmerged work was discarded.' });
            continue;
          }
          // Narrow the listing/compare-to-delete race with an immediate SHA
          // read-back. GitHub REST has no conditional ref-delete primitive, so
          // this is a guard rather than a claim of atomic deletion.
          const expectedSha = input.expected_sha === undefined ? entry.sha : text(input.expected_sha);
          const deletion = await deleteGitHubBranchIfUnchanged(request, base, entry.name, expectedSha);
          if (deletion.outcome === 'deleted') deleted.push(entry.name);
          else if (deletion.outcome === 'already_absent') alreadyAbsent.push(entry.name);
          else refused.push({ branch: entry.name, reason: deletion.reason });
        }

        return {
          repository: `${owner}/${repo}`,
          default_branch: defaultBranch,
          deleted,
          already_absent: alreadyAbsent,
          refused,
          next_step: deleted.length
            ? `Deleted ${deleted.length} branch(es) on GitHub: ${deleted.join(', ')}.${refused.length ? ` ${refused.length} refused.` : ''}`
            : `Nothing was deleted. ${refused.map((entry) => entry.reason).join(' ')}`
        };
      },
      forge_merge: async (input) => {
        const identity = deps.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
        const coordinator = await authorizedCoordinator(env, identity, workspaceId);
        const state = await coordinator.getAuthorizationBinding();
        // The branch is Forge's, not the agent's, so it does not have to know
        // or repeat it. If one is supplied it must be the workspace's own —
        // merging some other branch is never what was meant.
        const workspaceBranch = state.currentBranch ?? undefined;
        // `workspace` already resolved the workspace above; re-read just the
        // branch half of it (if the caller pinned one) to cross-check against
        // the workspace's actual branch — malformed input would already have
        // thrown inside resolveWorkspaceId, so this second parse cannot fail
        // where the first one succeeded.
        const requestedBranch = typeof input.workspace === 'string' && input.workspace.trim() && !isWorkspaceId(input.workspace)
          ? parseWorkspaceAddress(input.workspace.trim()).branch
          : undefined;
        const branch = requestedBranch === undefined ? (workspaceBranch ?? '') : requestedBranch;
        if (!branch) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'This workspace has no agent branch to merge yet — nothing has been edited. Call forge_edit to make a change, then call forge_merge again.',
            retryable: false
          });
        }
        if (workspaceBranch && branch !== workspaceBranch) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `This workspace is on ${workspaceBranch}, not ${branch}. Omit workspace, or pass workspace:'${workspaceBranch}', and forge_merge merges the one you have been editing.`,
            retryable: false,
            details: { workspaceBranch, requested: branch }
          });
        }
        assertForgeBranch(branch);
        const prBase = input.pr_base !== undefined
          ? text(input.pr_base)
          : (input.base !== undefined ? text(input.base) : 'main');
        const taskIdInput = input.task_id ? text(input.task_id) : null;
        let title = input.title === undefined ? '' : text(input.title);
        let body = input.body === undefined ? '' : text(input.body);

        const comparisonRef = input.base !== undefined
          ? text(input.base)
          : state.requestedRef.startsWith('forge/')
            ? prBase
            : state.requestedRef;
        const repository = state.repository as RepositoryRef;
        const request = await githubRequestForWorkspace(env, identity, { repository });
        const compared = await request(
          `/repos/${repository.owner}/${repository.name}/compare/${encodeURIComponent(comparisonRef)}...${encodeURIComponent(branch)}`
        );
        if (compared.status !== 200) {
          throw new ForgeError({
            code: compared.status === 404 ? 'FORGE_FILE_NOT_FOUND' : 'FORGE_PROVIDER_UNAVAILABLE',
            message: `GitHub could not prepare the submission because GitHub returned HTTP ${compared.status} comparing ${comparisonRef}...${branch}. The executor checkout was not consulted; check both branches with forge_branches before retrying.`,
            retryable: compared.status >= 500,
            details: { comparisonRef, branch, status: compared.status, source: 'github' }
          });
        }
        const comparison = compared.json as {
          ahead_by?: number;
          files?: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
        };
        const changedFiles = comparison.files ?? [];
        const diff = changedFiles.map((file) => [
          `diff --git a/${file.filename} b/${file.filename}`,
          `--- a/${file.filename}`,
          `+++ b/${file.filename}`,
          file.patch ?? `Binary or oversized ${file.status} file (${file.additions} additions, ${file.deletions} deletions)`
        ].join('\n')).join('\n').slice(0, 48_000);
        const filesChanged = changedFiles.length;
        const outgoing = {
          totalFiles: filesChanged,
          totalAdditions: changedFiles.reduce((sum, file) => sum + file.additions, 0),
          totalDeletions: changedFiles.reduce((sum, file) => sum + file.deletions, 0)
        };
        // Nothing to review is a mistake worth naming, not an empty pull request
        // for someone to puzzle over later.
        if (filesChanged === 0) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `There is nothing to submit: ${branch} has no changes against ${comparisonRef}. Make the change first, then submit.`,
            retryable: false,
            details: {
              comparisonRef,
              prBase,
              requestedRef: comparisonRef,
              head: branch
            }
          });
        }

        // Give the reviewer something readable to decide on. Best-effort: a
        // missing summariser must never be what stops work being submitted.
        if (!title.trim() && aiEnabled(env) && diff.trim()) {
          const summary = await summarizeDiffForPr(env, diff, { branch, base: prBase }).catch(() => undefined);
          if (summary) {
            title = summary.title;
            if (!body.trim()) body = summary.body;
          }
        }
        if (!title.trim()) title = `Forge: ${branch}`;

        // The commits must be somewhere durable before anything is promised to a
        // human. Under remote-first editing they already are: forge_edit put
        // them on origin/<branch> as it made them. Verify that with the same
        // GitHub API path forge_edit uses — forge_merge itself never pushes,
        // so there is nothing to fall back to if the branch is not there.
        // That fallback (stage, then force-push the feature branch) is what
        // 403'd in the wild: an agent's commit was already on origin,
        // forge_merge pushed it again, and the whole merge was reported
        // broken while the work sat safely on the branch the whole time.
        const remoteHead = await verifyFeatureBranchOnOrigin(request, repository, branch);
        const staged = { ref: branch, commit: remoteHead, remote_sha: remoteHead };

        let diffArtifactId: string | undefined;
        if (diff.trim() && utf8Bytes(diff) > 4_096) {
          const spilled = await spillTextArtifact(env, identity, workspaceId, 'submit-diff', diff, 'text/x-diff');
          diffArtifactId = spilled.artifact_id;
        }
        const approval = await requestApproval(
          env,
          identity,
          workspaceId,
          'work.submit',
          `Merge ${branch} into ${prBase}`,
          {
            branch,
            base: prBase,
            comparisonRef,
            title,
            body,
            commit: staged.commit,
            ...(diffArtifactId
              ? { diffArtifactId, diffTotals: { files: filesChanged, additions: outgoing?.totalAdditions ?? 0, deletions: outgoing?.totalDeletions ?? 0 } }
              : { diff: diff.slice(0, 48_000), diffTotals: { files: filesChanged, additions: outgoing?.totalAdditions ?? 0, deletions: outgoing?.totalDeletions ?? 0 } })
          }
        );
        await createDeferredAction(env, {
          tenantId: identity.tenantId,
          projectId: identity.projectId,
          workspaceId,
          approvalId: approval.approval_id,
          taskId: taskIdInput,
          action: 'work.submit',
          repository: { provider: 'github', owner: state.repository.owner, name: state.repository.name },
          // Pin the immutable id too: this submission may not be approved for
          // days, and a GitHub rename in the meantime would leave the slug alone
          // pointing at nothing.
          githubRepositoryId: await env.METADATA.prepare(
            "SELECT github_repository_id AS id FROM repositories WHERE tenant_id=?1 AND provider='github' AND owner=?2 AND name=?3 LIMIT 1"
          ).bind(identity.tenantId, state.repository.owner, state.repository.name)
            .first<{ id: string | null }>().then((row) => row?.id ?? null).catch(() => null),
          branch,
          base: prBase,
          stagedRef: staged.ref,
          commitSha: staged.commit,
          title,
          body,
          summary: `${filesChanged} file${filesChanged === 1 ? '' : 's'} changed`,
          filesChanged
        });

        await deps.recordAudit(
          'work.submit',
          identity.tenantId,
          { branch, prBase, comparisonRef, stagedRef: staged.ref, commit: staged.commit, approvalId: approval.approval_id },
          { workspaceId }
        );
        const submittedAt = new Date().toISOString();
        await new D1TaskStore(env.METADATA).getByWorkspace(workspaceId).then(async (task) => {
          if (!task) return;
          await new D1TaskStore(env.METADATA).put({ ...task, submittedAt, updatedAt: submittedAt });
        }).catch(() => undefined);

        return {
          submitted: true,
          submission_receipt: {
            branch,
            remote_sha: staged.remote_sha,
            staged_ref: staged.ref,
            approval_id: approval.approval_id,
            approval_url: approval.approval_url,
            files_changed: filesChanged,
            // Asserted from the ref actually read back off origin, not
            // hardcoded. verifyFeatureBranchOnOrigin already throws above when
            // this would be false, so reaching here always means true — but
            // the field still reads it off `remoteHead` rather than assuming
            // it, in case that guard ever changes.
            feature_branch_on_origin: Boolean(remoteHead)
          },
          next_step: `Echo only submission_receipt to the human. Branch ${branch}@${staged.remote_sha} is verified on origin; approve at ${approval.approval_url}.`
        };
      },
      forge_workspace_destroy: async (input) => {
        const identity = deps.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input)) as WorkspaceId;
        const idempotencyKey = idempotency(input.idempotency_key);
        const request = await (await authorizedCoordinator(env, identity, workspaceId)).requestDestroy({
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey,
          force: Boolean(input.force)
        });
        if (request.state !== 'destroyed') {
          const workflowId = workflowInstanceId('destroy', workspaceId);
          try {
            await env.DESTROY_WORKFLOW.create({
              id: workflowId,
              params: {
                workspaceId,
                idempotencyKey,
                preserveArtifacts: Boolean(input.preserve_artifacts),
                force: Boolean(input.force)
              }
            });
          } catch {
            await env.DESTROY_WORKFLOW.get(workflowId);
          }
        }
        await deps.recordAudit(
          'workspace.destroy',
          identity.tenantId,
          { forced: Boolean(input.force), preserveArtifacts: Boolean(input.preserve_artifacts) },
          { workspaceId }
        );
        return {
          workspace_id: workspaceId,
          state: request.state,
          operation_id: request.operationId,
          workspace_revision: request.workspaceRevision,
          replay: request.replay
        };
      },

  };
}
