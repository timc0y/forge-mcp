/**
 * What a mutating tool call actually achieved.
 *
 * The incident this file exists for: an agent wrote a document, Forge
 * auto-committed it on a `forge/` branch, the push failed, and the agent
 * reported the work as being "on the branch" — naming a real branch and a real
 * commit SHA. Every fact it cited was true and the conclusion was still wrong,
 * because a branch name, a commit SHA and an outgoing diff are all equally
 * true of work that exists only inside a temporary workspace. The workspace
 * was later reaped and the document went with it.
 *
 * The design conclusion is that local editing and remote persistence are
 * separate outcomes and must be reported separately. A tool returns as soon as
 * the edit is committed and checkpointed; the push is a distinct, separately
 * recoverable step. So one field answers "did my edit land?" and a second
 * answers "does it survive the workspace?" — and neither can be mistaken for
 * the other.
 */

/** What happened to the workspace. */
export type MutationOutcome =
  /** Nothing changed — the content was already what was asked for. */
  | 'unchanged'
  /** Files changed on disk but nothing is committed yet. */
  | 'workspace_changed'
  /** Committed inside the workspace. Dies with the workspace. */
  | 'committed_local'
  /** Committed and verified present on the origin branch. */
  | 'pushed_remote'
  /** Forge could not establish what happened. Read before retrying. */
  | 'unknown';

/** Where the work now lives. */
export type DurabilityState = 'local_only' | 'remote_branch' | 'pull_request' | 'failed_recovered';

export interface DurabilityVerdict {
  mutationOutcome: MutationOutcome;
  durability: DurabilityState;
  /** True only when the commit is verified present on origin. */
  on_remote: boolean;
  /** A complete sentence stating the storage boundary. Safe to echo as-is. */
  durability_statement: string;
  remote_branch?: string;
  remote_sha?: string;
}

/**
 * Build the verdict from workspace facts.
 *
 * `pushVerified` must come from a real remote read-back (`git ls-remote`
 * matching HEAD), never from a push command's exit code alone.
 */
export function describeDurability(input: {
  branch?: string;
  commit?: string;
  hasUnpushedWork?: boolean;
  pushVerified?: boolean;
  remoteSha?: string;
  pushFailureReason?: string;
  pullRequestUrl?: string;
  /** False when this call found nothing to commit (a replayed or repeated edit). */
  committed?: boolean;
}): DurabilityVerdict {
  const branch = input.branch;
  const onRemote = input.pushVerified === true || input.hasUnpushedWork === false;
  const remoteSha = input.remoteSha ?? (onRemote ? input.commit : undefined);
  const nothingToDo = input.committed === false;

  if (onRemote && input.pullRequestUrl) {
    return {
      mutationOutcome: nothingToDo ? 'unchanged' : 'pushed_remote',
      durability: 'pull_request',
      on_remote: true,
      durability_statement: `Pushed to origin/${branch} (${short(remoteSha)}) and a pull request is open at ${input.pullRequestUrl}.`,
      ...(branch ? { remote_branch: branch } : {}),
      ...(remoteSha ? { remote_sha: remoteSha } : {})
    };
  }

  if (onRemote) {
    return {
      mutationOutcome: nothingToDo ? 'unchanged' : 'pushed_remote',
      durability: 'remote_branch',
      on_remote: true,
      durability_statement: nothingToDo
        ? `Nothing to commit — origin/${branch} is already at ${short(remoteSha)}. No new work was created by this call.`
        : `Pushed and verified on GitHub: origin/${branch} is at ${short(remoteSha)}. This survives the workspace.`,
      ...(branch ? { remote_branch: branch } : {}),
      ...(remoteSha ? { remote_sha: remoteSha } : {})
    };
  }

  const because = input.pushFailureReason ? ` Push failed: ${input.pushFailureReason.slice(0, 200)}.` : '';
  return {
    mutationOutcome: 'committed_local',
    durability: 'local_only',
    on_remote: false,
    durability_statement:
      `Committed in this Forge workspace only — ${branch ?? 'the branch'} at ${short(input.commit)} is NOT on GitHub and will be lost when the workspace ends.${because}` +
      ' Do not describe this work as being "on the branch" until a push is verified.'
  };
}

function short(sha?: string): string {
  return sha ? sha.slice(0, 12) : 'unknown';
}

/**
 * The next action an agent should take, given a verdict. Kept next to the
 * verdict so the steer and the state can never drift apart.
 */
export function durabilityNextStep(verdict: DurabilityVerdict): string {
  if (verdict.mutationOutcome === 'committed_local') {
    // The edit itself succeeded. Say so first, or the agent re-applies it and
    // then meets "nothing to commit" as a second, unrelated-looking fault.
    return 'Your edit IS committed in the workspace — do NOT repeat it. It is LOCAL ONLY and not yet on GitHub. Retry the edit with forge_edit before reporting this work as saved; if it cannot reach GitHub, say so explicitly.';
  }
  switch (verdict.durability) {
    case 'remote_branch':
      return `Verified on origin/${verdict.remote_branch}. Safe to report as saved. Use forge_merge to open a pull request.`;
    case 'pull_request':
      return 'Pushed and a pull request is open. Report the PR URL.';
    case 'failed_recovered':
      return 'The workspace failed. Supply the content as an artifact and state plainly that nothing reached GitHub.';
    default:
      return 'Work is LOCAL ONLY. Retry the push before reporting this work as saved.';
  }
}
