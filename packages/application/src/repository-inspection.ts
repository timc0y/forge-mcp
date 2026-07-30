import { ForgeError, nextRevision } from '@forge/core';
import type { SandboxHandle } from '@forge/sandbox-core';

import type { WorkspaceRuntimeRecord } from './index.js';

export interface RepositoryInspectionResult {
  state: 'matches' | 'mount_missing' | 'diverged' | 'unavailable';
  commit?: string;
  branch?: string;
  diagnostic?: { code: string; providerCode?: string; operation?: string };
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function diagnostic(error: unknown): NonNullable<RepositoryInspectionResult['diagnostic']> {
  if (error instanceof ForgeError) {
    const details = error.details as Record<string, unknown> | undefined;
    return {
      code: error.code,
      ...(typeof details?.providerCode === 'string' ? { providerCode: details.providerCode } : {}),
      ...(typeof details?.operation === 'string' ? { operation: details.operation } : {})
    };
  }
  return { code: 'UNKNOWN' };
}

/**
 * Owns the fail-closed repository checks for an ephemeral executor checkout.
 * It observes executor state only; GitHub remains the durable repository authority.
 */
export class RepositoryInspection {
  async identity(handle: SandboxHandle): Promise<{ commit: string; branch?: string }> {
    const result = await handle.exec({
      command: 'git rev-parse HEAD && git branch --show-current',
      cwd: '/workspace/repo',
      timeoutMs: 30_000,
      outputLimitBytes: 10_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    });
    if (result.exitCode !== 0 || result.truncated) {
      throw new ForgeError({
        code: 'FORGE_GIT_DIRTY',
        message: 'Forge could not read the checked-out Git identity.',
        retryable: false,
        details: { truncated: result.truncated }
      });
    }
    const [commit = '', branch = ''] = result.stdout.trim().split('\n');
    if (!commit) {
      throw new ForgeError({
        code: 'FORGE_GIT_DIRTY',
        message: 'Workspace Git state has no checked-out commit.',
        retryable: false
      });
    }
    return { commit, ...(branch ? { branch } : {}) };
  }

  noteDivergence(
    record: WorkspaceRuntimeRecord,
    observed: { commit?: string; branch?: string }
  ): void {
    record.lastGitDivergence = {
      recordedCommit: record.workspace.currentCommit,
      recordedBranch: record.workspace.currentBranch,
      observedCommit: observed.commit ?? '',
      observedBranch: observed.branch ?? '',
      observedAt: new Date().toISOString()
    };
    record.workspace.updatedAt = new Date().toISOString();
  }

  /** Verify the workspace marker and recorded Git identity without waking a shell first. */
  async inspect(
    handle: SandboxHandle,
    record: WorkspaceRuntimeRecord
  ): Promise<RepositoryInspectionResult> {
    const markerFile = await handle.readFile({
      path: '/workspace/forge/workspace-id',
      maxBytes: 512
    }).catch((error) => ({ error }));
    if ('error' in markerFile) {
      const markerDiagnostic = diagnostic(markerFile.error);
      if (markerDiagnostic.code !== 'FORGE_FILE_NOT_FOUND') {
        return { state: 'unavailable', diagnostic: markerDiagnostic };
      }
      const scaffold = await handle.listFiles({
        path: '/workspace',
        depth: 16,
        limit: 4_000
      }).catch((error) => ({ error }));
      if ('error' in scaffold) return { state: 'unavailable', diagnostic: diagnostic(scaffold.error) };
      if (scaffold.truncated) {
        return { state: 'unavailable', diagnostic: { code: 'FORGE_OUTPUT_TRUNCATED', operation: 'workspace_scaffold_probe' } };
      }
      const hasCheckout = scaffold.entries.some((entry) => entry.path === '/workspace/repo/.git' || entry.path.startsWith('/workspace/repo/.git/'));
      const hasFileLikeContent = scaffold.entries.some((entry) => entry.type === 'file' || entry.type === 'symlink');
      if (!hasCheckout && !hasFileLikeContent) return { state: 'mount_missing' };
      if (!hasCheckout) {
        return { state: 'unavailable', diagnostic: { code: 'FORGE_WORKSPACE_MARKER_MISSING', operation: 'workspace_scaffold_probe' } };
      }
    }
    if (!('error' in markerFile) && markerFile.truncated) {
      return { state: 'unavailable', diagnostic: { code: 'FORGE_OUTPUT_TRUNCATED', operation: 'workspace_marker_read' } };
    }
    const marker = await handle.exec({
      command: `test "$(cat /workspace/forge/workspace-id 2>/dev/null)" = ${quoted(record.workspace.id)} && test -d /workspace/repo/.git`,
      cwd: '/workspace',
      timeoutMs: 30_000,
      outputLimitBytes: 10_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    }).catch((error) => ({ error }));
    if ('error' in marker) return { state: 'unavailable', diagnostic: diagnostic(marker.error) };
    if (marker.exitCode !== 0 || marker.truncated) {
      return { state: 'unavailable', diagnostic: { code: marker.truncated ? 'FORGE_OUTPUT_TRUNCATED' : 'FORGE_WORKSPACE_MARKER_MISSING', operation: 'workspace_marker_probe' } };
    }
    const identity = await this.identity(handle).catch((error) => ({ error }));
    if ('error' in identity) return { state: 'unavailable', diagnostic: diagnostic(identity.error) };
    if (!record.workspace.currentCommit) {
      return { state: 'unavailable', diagnostic: { code: 'FORGE_GIT_DIRTY', operation: 'workspace_git_identity' } };
    }
    if (
      identity.commit === record.workspace.currentCommit &&
      identity.branch === record.workspace.currentBranch
    ) return { state: 'matches', ...identity };
    return { state: 'diverged', ...identity };
  }

  async assertCheckoutPresent(record: WorkspaceRuntimeRecord, handle: SandboxHandle): Promise<void> {
    if (!['ready', 'busy'].includes(record.workspace.state)) return;
    const checkedAt = new Date().toISOString();
    const probe = await handle.exec({
      command: 'test -d /workspace/repo/.git && echo forge_checkout_present || echo forge_checkout_missing',
      cwd: '/workspace',
      timeoutMs: 10_000,
      outputLimitBytes: 1_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    });
    if (probe.stdout.includes('forge_checkout_present')) {
      record.workspace.checkout = { healthy: true, checkedAt };
      return;
    }
    record.workspace.state = 'failed';
    record.workspace.checkout = {
      healthy: false,
      checkedAt,
      detail: 'The repository checkout at /workspace/repo is missing.'
    };
    record.workspace.failure = {
      stage: 'checkout',
      code: 'FORGE_PROVIDER_UNAVAILABLE',
      message: 'The repository checkout is no longer available in the workspace.',
      retryable: false
    };
    record.workspace.revision = nextRevision(record.workspace.revision);
    record.workspace.updatedAt = checkedAt;
    throw new ForgeError({
      code: 'FORGE_WORKSPACE_NOT_READY',
      message: 'The repository checkout is missing; the workspace has been marked failed. Create a new workspace to continue.',
      retryable: false,
      details: { checkout: 'missing' }
    });
  }

  async status(record: WorkspaceRuntimeRecord, handle: SandboxHandle) {
    const status = await handle.exec({
      command: 'git status --porcelain=v2 --branch',
      cwd: '/workspace/repo',
      timeoutMs: 30_000,
      outputLimitBytes: 200_000,
      sessionId: 'agent-default',
      networkPolicy: 'deny_all'
    });
    const changed = await handle.exec({
      command: 'git diff --name-only -z && git diff --cached --name-only -z && git ls-files --others --exclude-standard -z',
      cwd: '/workspace/repo',
      timeoutMs: 30_000,
      outputLimitBytes: 200_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    });
    if (changed.exitCode !== 0 || changed.truncated) {
      throw new ForgeError({
        code: 'FORGE_OUTPUT_TRUNCATED',
        message: 'Forge could not completely enumerate workspace changes.',
        retryable: false,
        details: { truncated: changed.truncated }
      });
    }
    const changedPaths = [...new Set(changed.stdout.split('\0').filter(Boolean))];
    return {
      workspaceId: record.workspace.id,
      repository: record.workspace.repository,
      raw: status.stdout,
      commit: record.workspace.currentCommit,
      baseCommit: record.workspace.baseCommit ?? null,
      filesystemRevision: record.workspace.revision,
      changedPaths,
      clean: !status.stdout.split('\n').some((line) => line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('? ')),
      branch: record.workspace.currentBranch ?? record.workspace.requestedRef
    };
  }
}
