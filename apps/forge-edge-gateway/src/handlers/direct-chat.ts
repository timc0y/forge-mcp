/**
 * The ordinary-chat facade.
 *
 * This is deliberately not another task/workspace API.  A chat model should
 * be able to stop after any successful call without having orphaned the work:
 * GitHub is the source of truth for repository operations, and the executor
 * is only ever an implementation detail of command/preview operations.
 *
 * The facade has a small dependency boundary so the MCP adapter can expose it
 * without teaching clients about workspace ids, process ids, vault bindings,
 * or approval redemption.  The existing handlers remain the implementation of
 * those private operations while they are progressively moved behind this
 * boundary.
 */
import { ForgeError, toForgeError, type TenantId } from '@forge/core';
import { commitFilesToBranch, RemoteCommitConflict } from '@forge/git-github';
import { type ForgeToolHandlers, type ForgeToolResponse } from '@forge/mcp-core';
import type { Env } from '../env';
import {
  githubRequestForWorkspace,
  listAuthorizedRepositories,
  repositoryAccessDiagnosis
} from '../github';
import {
  githubRepository,
  listEntriesFromTree,
  readBlobFromTree,
  type GitHubBranchTree
} from '../github-repository';
import { applyReplacements, ReplacementFailed } from '../apply-replacements';
import { normalizeRepoPath } from '../repo-paths';
import type { HandlerIdentity } from './types';

export interface DirectRepository {
  owner: string;
  repo: string;
}

export interface DirectReceipt extends Record<string, unknown> {
  /** A chat-safe terminal/continuation state; never requires a hidden id. */
  state: 'completed' | 'running' | 'approval_required' | 'failed' | 'expired';
  summary: string;
  next_action: 'none' | { kind: 'tool' | 'human'; message: string; tool?: string };
}

export interface DirectChatPrivateOperations {
  /**
   * Materialize `ref` in an ephemeral executor and execute one command.
   * Returned filesystem changes must be discarded by the implementation.
   */
  run(input: {
    identity: HandlerIdentity;
    repository: DirectRepository;
    ref: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
  }): Promise<Record<string, unknown>>;
  /** Capture a public URL or a ref after private preview bootstrap. */
  screenshot(input: {
    identity: HandlerIdentity;
    target: { kind: 'url'; url: string } | { kind: 'repository'; repository: DirectRepository; ref: string };
    captures: Array<{ path: string; state: string; selection?: string }>;
    steps?: Array<Record<string, unknown>>;
    viewports: Array<'phone' | 'tablet' | 'desktop' | { id: string; width: number; height: number }>;
    fullPage: boolean;
  }): Promise<Record<string, unknown> | ForgeToolResponse>;
  environments(input: { identity: HandlerIdentity; repository: DirectRepository }): Promise<Record<string, unknown>>;
  /** Starts deferred approval. It must not require a later MCP call to execute. */
  deploy(input: {
    identity: HandlerIdentity;
    repository: DirectRepository;
    ref: string;
    environment: string;
  }): Promise<Record<string, unknown>>;
  submit(input: {
    identity: HandlerIdentity;
    repository: DirectRepository;
    branch: string;
    baseRef?: string;
    title?: string;
    body?: string;
  }): Promise<Record<string, unknown>>;
  /** Optional operation registry/status-page seam. It is intentionally not D1-owned here. */
  status?(input: { identity: HandlerIdentity; reference: string }): Promise<Record<string, unknown> | null>;
}

export interface DirectChatDependencies {
  identity(): HandlerIdentity;
  privateOperations: DirectChatPrivateOperations;
}

export interface DirectEditFile {
  path: string;
  /** Whole content is allowed only for a new file. Use replacements for existing files. */
  content?: string | null;
  replace?: Array<{ old: string; new: string; all?: boolean }>;
}

function receipt(
  state: DirectReceipt['state'],
  summary: string,
  next: DirectReceipt['next_action'],
  extra: Record<string, unknown> = {}
): DirectReceipt {
  return { state, summary, next_action: next, ...extra };
}

/** IDs used to operate the old control plane must never become a Chat contract. */
function withoutControlPlaneIds(value: Record<string, unknown>): Record<string, unknown> {
  const {
    workspaceId: _workspaceId,
    workspace_id: _workspace_id,
    taskId: _taskId,
    task_id: _task_id,
    processId: _processId,
    process_id: _process_id,
    previewId: _previewId,
    preview_id: _preview_id,
    operationId: _operationId,
    operation_id: _operation_id,
    originalOperationId: _originalOperationId,
    original_operation_id: _original_operation_id,
    chat_operation_id: _chatOperationId,
    workspaceRevision: _workspaceRevision,
    workspace_revision: _workspace_revision,
    artifactRefs: _artifactRefs,
    artifact_refs: _artifact_refs,
    allowedNextActions: _allowedNextActions,
    allowed_next_actions: _allowed_next_actions,
    nextStep: _nextStep,
    next_step: _next_step,
    ...publicValue
  } = value;
  return publicValue;
}

function isForgeToolResponse(value: Record<string, unknown> | ForgeToolResponse): value is ForgeToolResponse {
  return (value as ForgeToolResponse).kind === 'forge_tool_response';
}

function publicExecutorError(error: unknown, action: 'forge_run' | 'forge_screenshot' | 'forge_deploy'): unknown {
  const forgeError = error instanceof ForgeError
    ? error
    : typeof error === 'object' && error !== null
      ? toForgeError(error)
      : undefined;
  if (!forgeError) return error;
  const details = forgeError.details ?? {};
  const hasPrivateDetails = [
    'workspace_id', 'workspaceId', 'process_id', 'processId', 'operation_id', 'operationId'
  ].some((key) => key in details);
  const hasPrivateGuidance = /workspace_id|process_id|forge_workspace_get|forge_process_|forge_deps_install/iu.test(forgeError.message);
  if (forgeError.code !== 'FORGE_WORKSPACE_NOT_READY' && forgeError.code !== 'FORGE_WORKSPACE_CONFLICT' && !hasPrivateDetails && !hasPrivateGuidance) return error;
  const label = action === 'forge_run' ? 'command' : action === 'forge_screenshot' ? 'branch preview' : 'deployment';
  return new ForgeError({
    code: forgeError.code,
    message: `Forge could not prepare the private executor for this ${label}. Retry ${action} with the same repository and branch; Forge will reuse any existing startup.`,
    retryable: forgeError.retryable,
    details: { allowedNextActions: [action] }
  });
}

/** Keep private executor choreography out of ordinary-chat error receipts. */
function publicPreviewError(error: unknown): unknown {
  const forgeError = error instanceof ForgeError
    ? error
    : typeof error === 'object' && error !== null
      ? toForgeError(error)
      : undefined;
  if (!forgeError) return error;
  if (forgeError.code !== 'FORGE_PREVIEW_UNAVAILABLE') {
    return publicExecutorError(error, 'forge_screenshot');
  }
  const message = forgeError.message.toLowerCase();
  if (message.includes('no dev server command') || message.includes('no preview')) {
    return new ForgeError({
      code: forgeError.code,
      message: 'No branch preview command was detected. Add a root package.json dev script, or use forge_edit to commit a repo-root forge.json or forge.config.json with preview.command and optional preview.cwd/preview.port, then retry forge_screenshot.',
      retryable: false,
      details: { allowedNextActions: ['forge_edit', 'forge_screenshot'] }
    });
  }
  if (message.includes('forge config')) {
    return new ForgeError({
      code: forgeError.code,
      message: 'Forge rejected the repository preview configuration. Use forge_edit to correct the repo-root forge.json or forge.config.json; preview.cwd must stay inside the repository, preview.port must be 1024–65535, and preview.command must be a bounded string.',
      retryable: false,
      details: { allowedNextActions: ['forge_edit', 'forge_screenshot'] }
    });
  }
  return new ForgeError({
    code: forgeError.code,
    message: 'Forge could not start the branch preview inside this request. Retry forge_screenshot; Forge will reuse the existing preview when possible.',
    retryable: true,
    details: { allowedNextActions: ['forge_screenshot'] }
  });
}

function repositoryOf(input: DirectRepository): { provider: 'github'; owner: string; name: string } {
  const owner = input.owner.trim();
  const name = input.repo.trim();
  if (!owner || !name) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'Repository owner and name are required; use forge_repositories to copy the owner/repo address.',
      retryable: false
    });
  }
  return { provider: 'github', owner, name };
}

function refPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

async function shortIntentHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function directBranch(identity: HandlerIdentity, repository: DirectRepository, intent: string): Promise<string> {
  const normalized = intent.trim();
  if (!normalized) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'An edit intent is required so Forge can reuse its GitHub branch; pass a short intent to forge_edit.',
      retryable: false
    });
  }
  const hash = await shortIntentHash(`${identity.tenantId}:${identity.projectId}:${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}:${normalized}`);
  return `forge/chat-${hash}`;
}

async function branchTip(request: Awaited<ReturnType<typeof githubRequestForWorkspace>>, repository: DirectRepository, ref: string): Promise<string | undefined> {
  const result = await request(`/repos/${repository.owner}/${repository.repo}/git/ref/heads/${refPath(ref)}`);
  if (result.status === 404) return undefined;
  if (result.status !== 200) {
    throw new ForgeError({
      code: 'FORGE_PROVIDER_UNAVAILABLE',
      message: `GitHub returned HTTP ${result.status} reading ${repository.owner}/${repository.repo}#${ref}; retry forge_read if the provider failure is temporary.`,
      retryable: result.status >= 500
    });
  }
  const sha = (result.json as { object?: { sha?: string } }).object?.sha;
  if (!sha) throw new ForgeError({ code: 'FORGE_PROVIDER_UNAVAILABLE', message: 'GitHub returned a branch without a commit SHA; retry forge_read after the provider recovers.', retryable: true });
  return sha;
}

async function defaultBranchAndTip(request: Awaited<ReturnType<typeof githubRequestForWorkspace>>, repository: DirectRepository): Promise<{ branch: string; sha: string }> {
  const repositoryResponse = await request(`/repos/${repository.owner}/${repository.repo}`);
  if (repositoryResponse.status !== 200) {
    throw new ForgeError({
      code: repositoryResponse.status === 404 ? 'FORGE_FILE_NOT_FOUND' : 'FORGE_PROVIDER_UNAVAILABLE',
      message: `GitHub could not read ${repository.owner}/${repository.repo} (HTTP ${repositoryResponse.status}).`,
      retryable: repositoryResponse.status >= 500
    });
  }
  const branch = String((repositoryResponse.json as { default_branch?: string }).default_branch ?? 'main');
  const sha = await branchTip(request, repository, branch);
  if (!sha) throw new ForgeError({ code: 'FORGE_PROVIDER_UNAVAILABLE', message: `GitHub did not return the default branch ${branch}; pass an explicit ref to forge_read.`, retryable: true });
  return { branch, sha };
}

function decodeGitHubContent(content: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(content.replace(/\n/gu, '')), (character) => character.charCodeAt(0)));
}

function asCommitFiles(files: DirectEditFile[], branch: string, baseSha: string, repo: ReturnType<typeof githubRepository>) {
  return Promise.all(files.map(async (file) => {
    const path = normalizeRepoPath(file.path);
    const suppliedKinds = Number(file.content !== undefined) + Number(file.replace !== undefined);
    if (suppliedKinds !== 1) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: `${path} needs exactly one of content or replace; use one bounded mode in forge_edit.`,
        retryable: false
      });
    }
    if (file.content !== undefined) {
      // A whole-file write can safely create/delete, but it cannot silently
      // replace an existing file that a chat has not held in context.
      const source = await repo.readFragmentSource({ branch, baseSha, path });
      if (source.ok) {
        if (file.content === null) return { path, content: null, expectedBlob: source.body.sha };
        throw new ForgeError({
          code: 'FORGE_FILE_CONFLICT',
          message: `${path} already exists. Read it and send a fragment replacement instead of a blind whole-file overwrite.`,
          retryable: false,
          details: { path }
        });
      }
      if (source.kind === 'file_missing' || source.kind === 'base_unavailable') return { path, content: file.content, expectedBlob: undefined };
      throw new ForgeError({ code: 'FORGE_PROVIDER_UNAVAILABLE', message: `GitHub returned HTTP ${source.status} reading ${path}; retry forge_edit after a temporary provider failure.`, retryable: source.status >= 500 });
    }
    const source = await repo.readFragmentSource({ branch, baseSha, path });
    if (!source.ok) {
      throw new ForgeError({
        code: source.kind === 'file_missing' ? 'FORGE_FILE_NOT_FOUND' : 'FORGE_PROVIDER_UNAVAILABLE',
        message: source.kind === 'file_missing' ? `${path} does not exist; use content in forge_edit to create it.` : `GitHub could not read ${path}; retry forge_edit after the provider recovers.`,
        retryable: source.kind !== 'file_missing'
      });
    }
    if (!source.body.content || !source.body.sha) {
      throw new ForgeError({ code: 'FORGE_FILE_CONFLICT', message: `${path} is not readable text; use forge_read to select a text source file instead.`, retryable: false });
    }
    try {
      return { path, content: applyReplacements(path, decodeGitHubContent(source.body.content), file.replace!), expectedBlob: source.body.sha };
    } catch (error) {
      if (error instanceof ReplacementFailed) {
        throw new ForgeError({ code: 'FORGE_FILE_CONFLICT', message: error.message, retryable: false, details: { path, reason: error.reason } });
      }
      throw error;
    }
  }));
}

/**
 * Build the ten direct-chat capabilities.  `privateOperations` deliberately
 * owns all executor, approval and status persistence so no public tool learns
 * how to drive the control plane.
 */
export function directChatHandlers(env: Env, deps: DirectChatDependencies) {
  const identity = () => deps.identity();
  const requestFor = async (repository: DirectRepository) => {
    const repo = repositoryOf(repository);
    return {
      repo,
      request: await githubRequestForWorkspace(env, identity(), { repository: repo })
    };
  };
  const readTree = async (repository: DirectRepository, ref?: string) => {
    const { repo, request } = await requestFor(repository);
    const selectedRef = ref?.trim() || (await defaultBranchAndTip(request, repository)).branch;
    return { repo, request, selectedRef, tree: await githubRepository(request, repo).readBranchTree(selectedRef) };
  };

  return {
    async repositories(query?: string): Promise<DirectReceipt> {
      const repositories = await listAuthorizedRepositories(env, identity().tenantId as TenantId);
      const needle = query?.trim().toLowerCase();
      const filtered = needle
        ? repositories.filter((entry) => `${entry.owner}/${entry.name}`.toLowerCase().includes(needle))
        : repositories;
      const diagnosis = filtered.length === 0 ? await repositoryAccessDiagnosis(env, identity().tenantId as TenantId) : undefined;
      return receipt('completed', `${filtered.length} authorized GitHub ${filtered.length === 1 ? 'repository' : 'repositories'} available.`, 'none', {
        repositories: filtered,
        ...(diagnosis ? { access: diagnosis } : {})
      });
    },

    async read(input: { repository: DirectRepository; ref?: string; paths?: string[]; path?: string; depth?: number; limit?: number; maxBytes?: number }): Promise<DirectReceipt> {
      const { selectedRef, tree, request, repo } = await readTree(input.repository, input.ref);
      const paths = input.paths ?? (input.path ? [input.path] : []);
      if (paths.length === 0) {
        const root = input.path ? normalizeRepoPath(input.path) : '';
        const listing = listEntriesFromTree(tree, root, Math.min(input.depth ?? 4, 20), Math.min(input.limit ?? 1_000, 2_000));
        return receipt('completed', `Listed ${listing.entries.length} paths from GitHub.`, 'none', {
          repository_ref: `${input.repository.owner}/${input.repository.repo}#${selectedRef}`,
          commit_sha: tree.commitSha,
          source: 'github',
          ...listing
        });
      }
      if (paths.length > 20) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Read at most 20 files per call; reduce forge_read paths and retry.', retryable: false });
      const maxBytes = Math.min(input.maxBytes ?? 100_000, 200_000);
      const files = await Promise.all(paths.map(async (untrustedPath) => {
        const path = normalizeRepoPath(untrustedPath);
        const entry = tree.entries.find((candidate) => candidate.path === path);
        const hasChildren = tree.entries.some((candidate) => candidate.path.startsWith(`${path}/`));
        if (entry?.type === 'tree' || (!entry && hasChildren)) {
          const listing = listEntriesFromTree(tree, path, Math.min(input.depth ?? 2, 10), Math.min(input.limit ?? 500, 1_000));
          return { path, kind: 'directory' as const, source: 'github' as const, ...listing };
        }
        const value = await readBlobFromTree(request, repo.owner, repo.name, tree, path, { maxBytes });
        return { ...value, kind: 'file' as const, source: 'github' as const };
      }));
      return receipt('completed', `Read ${files.length} authoritative GitHub ${files.length === 1 ? 'file' : 'files'}.`, 'none', {
        repository_ref: `${input.repository.owner}/${input.repository.repo}#${selectedRef}`,
        commit_sha: tree.commitSha,
        files: files.length === 1 ? undefined : files,
        ...(files.length === 1 ? files[0] : {})
      });
    },

    async search(input: { repository: DirectRepository; ref?: string; query: string; path?: string; limit?: number }): Promise<DirectReceipt> {
      const query = input.query.trim();
      if (!query) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'A query is required; pass the text or path fragment to forge_search.', retryable: false });
      const { selectedRef, tree, request, repo } = await readTree(input.repository, input.ref);
      const root = input.path ? normalizeRepoPath(input.path) : '';
      const candidates = tree.entries.filter((entry) => entry.type === 'blob' && (!root || entry.path === root || entry.path.startsWith(`${root}/`))).slice(0, 40);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const needle = query.toLowerCase();
      for (const entry of candidates) {
        if (matches.length >= (input.limit ?? 50)) break;
        if (entry.path.toLowerCase().includes(needle)) matches.push({ path: entry.path, line: 0, text: '[path match]' });
        if (matches.length >= (input.limit ?? 50)) break;
        try {
          const file = await readBlobFromTree(request, repo.owner, repo.name, tree, entry.path, { maxBytes: 20_000 });
          for (const [offset, line] of file.content.split('\n').entries()) {
            if (line.toLowerCase().includes(needle)) matches.push({ path: entry.path, line: offset + 1, text: line.slice(0, 500) });
            if (matches.length >= (input.limit ?? 50)) break;
          }
        } catch {
          // Search is best-effort across a bounded tree. A binary/unreadable
          // file must not hide matches already found in other files.
        }
      }
      return receipt('completed', `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} in GitHub.`, 'none', {
        repository_ref: `${input.repository.owner}/${input.repository.repo}#${selectedRef}`,
        commit_sha: tree.commitSha,
        matches,
        searched_files: candidates.length,
        search_limited: tree.truncated || candidates.length === 40
      });
    },

    async edit(input: { repository: DirectRepository; intent: string; baseRef?: string; branch?: string; files: DirectEditFile[]; message?: string }): Promise<DirectReceipt> {
      if (input.files.length === 0 || input.files.length > 10) {
        throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'An ordinary-chat edit changes 1–10 files; reduce the forge_edit file list.', retryable: false });
      }
      const total = input.files.reduce((sum, file) => sum + (file.content ? new TextEncoder().encode(file.content).byteLength : 0) + (file.replace ?? []).reduce((inner, item) => inner + new TextEncoder().encode(item.old).byteLength + new TextEncoder().encode(item.new).byteLength, 0), 0);
      if (total > 200_000) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'An ordinary-chat edit may contain at most 200 KB; reduce forge_edit change content.', retryable: false });
      const actor = identity();
      const { repo, request } = await requestFor(input.repository);
      const base = input.baseRef?.trim() || (await defaultBranchAndTip(request, input.repository)).branch;
      const branch = input.branch?.trim() || await directBranch(actor, input.repository, input.intent);
      if (!branch.startsWith('forge/chat-')) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Direct-chat edits only continue forge/chat-* branches; omit ref and pass an intent to forge_edit.', retryable: false });
      if (input.branch) {
        const submitted = await env.METADATA.prepare(
          `SELECT state FROM deferred_actions
           WHERE tenant_id = ? AND project_id = ? AND repo_owner = ? AND repo_name = ? AND branch = ?
             AND state IN ('awaiting_approval','executing','completed','failed')
           LIMIT 1`
        ).bind(actor.tenantId, actor.projectId, repo.owner, repo.name, branch).first<{ state: string }>();
        if (submitted) throw new ForgeError({
          code: 'FORGE_FILE_CONFLICT',
          message: `Intent branch ${branch} is sealed for review; pass a new intent to forge_edit instead of changing submitted work.`,
          retryable: false
        });
      }
      const baseSha = input.branch
        ? await branchTip(request, input.repository, branch)
        : await branchTip(request, input.repository, base);
      if (!baseSha) throw new ForgeError({
        code: 'FORGE_FILE_NOT_FOUND',
        message: input.branch
          ? `Intent branch ${branch} does not exist; omit ref and pass a new intent to forge_edit.`
          : `Base branch ${base} does not exist; use forge_read to choose an existing ref.`,
        retryable: false
      });
      const remote = githubRepository(request, repo);
      const resolved = await asCommitFiles(input.files, branch, baseSha, remote);
      const expectedBlobs = Object.fromEntries(resolved.filter((file) => file.expectedBlob).map((file) => [file.path, file.expectedBlob!]));
      try {
        const result = await commitFilesToBranch(request, {
          owner: repo.owner,
          repo: repo.name,
          branch,
          baseSha,
          message: input.message?.trim() || `Forge: ${input.intent.trim().slice(0, 180)}`,
          files: resolved.map(({ path, content }) => ({ path, content })),
          expectedBlobs,
          requireKnownBase: true
        });
        const sha = result.remoteSha;
        return receipt('completed', result.unchanged ? 'No GitHub commit was needed; the requested content already exists.' : `Committed and verified ${result.paths.length} file${result.paths.length === 1 ? '' : 's'} on GitHub.`, 'none', {
          repository_ref: `${repo.owner}/${repo.name}#${branch}`,
          branch,
          commit_sha: sha,
          commit_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
          on_remote: true,
          verified: result.pushVerified,
          paths: result.paths,
          remote_persisted: true
        });
      } catch (error) {
        if (error instanceof RemoteCommitConflict) {
          throw new ForgeError({ code: 'FORGE_FILE_CONFLICT', message: `${error.message} Re-read the named file and retry the edit.`, retryable: false, details: { paths: error.conflictingPaths } });
        }
        throw error;
      }
    },

    async run(input: { repository: DirectRepository; ref?: string; command: string; cwd?: string; timeoutMs?: number }): Promise<DirectReceipt> {
      const selectedRef = input.ref?.trim() || (await readTree(input.repository)).selectedRef;
      let value: Record<string, unknown>;
      try {
        value = await deps.privateOperations.run({ identity: identity(), repository: input.repository, ref: selectedRef, command: input.command, cwd: input.cwd, timeoutMs: Math.min(input.timeoutMs ?? 600_000, 600_000) });
      } catch (error) {
        throw publicExecutorError(error, 'forge_run');
      }
      const running = value.state === 'running' || value.status === 'running';
      return receipt(running ? 'running' : 'completed', running ? 'Command continues in Forge; do not re-run it.' : 'Command finished in an ephemeral executor.', running ? { kind: 'human', message: 'Open the returned status URL for the final result.' } : 'none', {
        ...withoutControlPlaneIds(value),
        repository_ref: `${input.repository.owner}/${input.repository.repo}#${selectedRef}`,
        remote_persisted: false,
        executor_filesystem: 'ephemeral'
      });
    },

    async screenshot(input: { target: { url: string } | { repository: DirectRepository; ref?: string }; captures?: Array<{ path: string; state?: string; selection?: string }>; steps?: Array<Record<string, unknown>>; viewports?: Array<'phone' | 'tablet' | 'desktop' | { id: string; width: number; height: number }>; fullPage?: boolean }): Promise<DirectReceipt | ForgeToolResponse> {
      const target = 'url' in input.target
        ? { kind: 'url' as const, url: input.target.url }
        : {
            kind: 'repository' as const,
            repository: input.target.repository,
            ref: input.target.ref?.trim() || (await readTree(input.target.repository)).selectedRef
          };
      let raw: Record<string, unknown> | ForgeToolResponse;
      try {
        raw = await deps.privateOperations.screenshot({ identity: identity(), target, captures: (input.captures ?? [{ path: '/', state: 'entry' }]).map((capture) => ({ path: capture.path, state: capture.state ?? 'entry', ...(capture.selection ? { selection: capture.selection } : {}) })), ...(input.steps ? { steps: input.steps } : {}), viewports: input.viewports ?? ['phone', 'desktop'], fullPage: input.fullPage === true });
      } catch (error) {
        throw publicPreviewError(error);
      }
      const value: Record<string, unknown> = isForgeToolResponse(raw) ? raw.value : raw;
      const result = receipt(value.complete === false ? 'running' : 'completed', value.complete === false ? 'Returned the screenshots captured before the deadline.' : 'Captured responsive screenshot evidence.', value.complete === false ? { kind: 'human', message: 'Open the gallery/status URL for remaining captures.' } : 'none', withoutControlPlaneIds(value));
      return isForgeToolResponse(raw)
        ? { kind: 'forge_tool_response', value: result, content: raw.content } as ForgeToolResponse
        : result;
    },

    async environments(repository: DirectRepository): Promise<DirectReceipt> {
      const value = await deps.privateOperations.environments({ identity: identity(), repository });
      return receipt('completed', 'Listed configured deployment environments without exposing secret values.', 'none', value);
    },

    async deploy(input: { repository: DirectRepository; ref?: string; environment: string }): Promise<DirectReceipt> {
      const selectedRef = input.ref?.trim() || (await readTree(input.repository)).selectedRef;
      let value: Record<string, unknown>;
      try {
        value = await deps.privateOperations.deploy({ identity: identity(), repository: input.repository, ref: selectedRef, environment: input.environment });
      } catch (error) {
        throw publicExecutorError(error, 'forge_deploy');
      }
      return receipt('approval_required', 'Deployment is staged for human approval and pinned to this repository ref.', { kind: 'human', message: 'Open the approval URL. Forge will execute and verify the deployment without another chat call.' }, {
        ...withoutControlPlaneIds(value),
        repository_ref: `${input.repository.owner}/${input.repository.repo}#${selectedRef}`
      });
    },

    async submit(input: { repository: DirectRepository; branch: string; baseRef?: string; title?: string; body?: string }): Promise<DirectReceipt> {
      const value = await deps.privateOperations.submit({ identity: identity(), repository: input.repository, branch: input.branch, baseRef: input.baseRef, title: input.title, body: input.body });
      const submission = value.submission_receipt && typeof value.submission_receipt === 'object'
        ? value.submission_receipt as Record<string, unknown>
        : {};
      return receipt('approval_required', 'Submitted the already-verified GitHub branch for deferred human review.', { kind: 'human', message: 'Open the approval URL; Forge creates the draft PR after approval.' }, {
        approval_url: submission.approval_url,
        commit_sha: submission.remote_sha,
        repository_ref: `${input.repository.owner}/${input.repository.repo}#${input.branch}`
      });
    },

    async status(reference: string): Promise<DirectReceipt> {
      const status = await deps.privateOperations.status?.({ identity: identity(), reference });
      if (!status) return receipt('completed', 'No active Forge operation matches this reference.', 'none');
      const state = status.state === 'failed' || status.state === 'expired' || status.state === 'approval_required' || status.state === 'running' ? status.state : 'completed';
      return receipt(state, String(status.summary ?? 'Recovered Forge operation status.'), state === 'approval_required' ? { kind: 'human', message: 'Open the returned approval URL.' } : 'none', {
        ...withoutControlPlaneIds(status),
      });
    }
  };
}

export type DirectChatHandlers = ReturnType<typeof directChatHandlers>;

function parseRepository(value: unknown): DirectRepository {
  if (typeof value !== 'string') throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Repository must be owner/repo; use forge_repositories to copy its exact address.', retryable: false });
  const [owner, repo, ...extra] = value.split('/');
  if (!owner || !repo || extra.length > 0) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Repository must be owner/repo; use forge_repositories to copy its exact address.', retryable: false });
  return { owner, repo };
}

function parseScreenshotTarget(value: unknown): { url: string } | { repository: DirectRepository; ref?: string } {
  if (typeof value !== 'string' || !value.trim()) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'A target is required; pass a public URL or owner/repo#ref to forge_screenshot.', retryable: false });
  if (/^https?:\/\//iu.test(value)) return { url: value };
  const [repository, ref] = value.split('#', 2);
  const parsed = parseRepository(repository);
  return { repository: parsed, ...(ref?.trim() ? { ref: ref.trim() } : {}) };
}

function wireValue(result: DirectReceipt): Record<string, unknown> {
  const { next_action, repository_ref, ...value } = result;
  return {
    ...value,
    ...(typeof repository_ref === 'string'
      ? (() => {
          const [repository, ref] = repository_ref.split('#', 2);
          return { repository, ...(ref ? { ref } : {}) };
        })()
      : {}),
    next_action
  };
}

function wireResult(result: DirectReceipt | ForgeToolResponse): Record<string, unknown> | ForgeToolResponse {
  if (isForgeToolResponse(result)) {
    return { ...result, value: wireValue(result.value as DirectReceipt) };
  }
  return wireValue(result);
}

/** Exact MCP map; all compact wire-shape normalization happens here. */
export function directChatToolHandlers(env: Env, deps: DirectChatDependencies): ForgeToolHandlers {
  const direct = directChatHandlers(env, deps);
  return {
    forge_repositories: async (input) => wireResult(await direct.repositories(typeof input.query === 'string' ? input.query : undefined)),
    forge_search: async (input) => wireResult(await direct.search({
      repository: parseRepository(input.repository),
      ...(typeof input.ref === 'string' ? { ref: input.ref } : {}),
      query: String(input.query ?? ''),
      ...(typeof input.path === 'string' ? { path: input.path } : {}),
      ...(typeof input.max_results === 'number' ? { limit: input.max_results } : {})
    })),
    forge_read: async (input) => wireResult(await direct.read({
      repository: parseRepository(input.repository),
      ...(typeof input.ref === 'string' ? { ref: input.ref } : {}),
      paths: Array.isArray(input.paths) ? input.paths.map(String) : [],
      ...(typeof input.max_bytes === 'number' ? { maxBytes: input.max_bytes } : {})
    })),
    forge_edit: async (input) => wireResult(await direct.edit({
      repository: parseRepository(input.repository),
      intent: typeof input.intent === 'string'
        ? input.intent
        : typeof input.ref === 'string'
          ? `Continue ${input.ref}`
          : (() => { throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'A new edit needs an intent; pass intent to forge_edit, or pass ref to continue an existing branch.', retryable: false }); })(),
      ...(typeof input.base_ref === 'string' ? { baseRef: input.base_ref } : {}),
      ...(typeof input.ref === 'string' ? { branch: input.ref } : {}),
      files: Array.isArray(input.files) ? input.files as DirectEditFile[] : [],
      ...(typeof input.message === 'string' ? { message: input.message } : {})
    })),
    forge_run: async (input) => wireResult(await direct.run({
      repository: parseRepository(input.repository),
      ref: String(input.ref ?? ''),
      command: String(input.command ?? ''),
      ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
      ...(typeof input.timeout_ms === 'number' ? { timeoutMs: input.timeout_ms } : {})
    })),
    forge_screenshot: async (input) => wireResult(await direct.screenshot({
      target: parseScreenshotTarget(input.target),
      captures: Array.isArray(input.paths) ? input.paths.map((path) => ({ path: String(path) })) : undefined,
      steps: Array.isArray(input.steps) ? input.steps as Array<Record<string, unknown>> : undefined,
      viewports: Array.isArray(input.viewports) ? input.viewports as Array<'phone' | 'tablet' | 'desktop' | { id: string; width: number; height: number }> : undefined,
      fullPage: input.full_page === true
    })),
    forge_environments: async (input) => wireResult(await direct.environments(parseRepository(input.repository))),
    forge_deploy: async (input) => wireResult(await direct.deploy({
      repository: parseRepository(input.repository),
      ref: String(input.ref ?? ''),
      environment: String(input.environment ?? '')
    })),
    forge_submit: async (input) => wireResult(await direct.submit({
      repository: parseRepository(input.repository),
      branch: String(input.ref),
      ...(typeof input.title === 'string' ? { title: input.title } : {}),
      ...(typeof input.body === 'string' ? { body: input.body } : {})
    })),
    forge_status: async (input) => wireResult(await direct.status(String(input.target ?? '')))
  };
}
