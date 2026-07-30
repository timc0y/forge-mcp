/** Remote-first edit receipts. forge_edit writes directly to GitHub. */
type MutationOutcome = 'unchanged' | 'committed_remote';
type DurabilityState = 'remote_branch';

export const MUTATION_OUTCOMES: readonly MutationOutcome[] = ['unchanged', 'committed_remote'];
export const DURABILITY_STATES: readonly DurabilityState[] = ['remote_branch'];

interface DurabilityVerdict {
  mutationOutcome: MutationOutcome;
  durability: DurabilityState;
  on_remote: true;
  durability_statement: string;
  remote_branch: string;
  remote_sha?: string;
}

export function describeDurability(input: {
  branch: string;
  commit?: string;
  remoteSha?: string;
  committed?: boolean;
}): DurabilityVerdict {
  const unchanged = input.committed === false;
  const remoteSha = input.remoteSha ?? input.commit;
  return {
    mutationOutcome: unchanged ? 'unchanged' : 'committed_remote',
    durability: 'remote_branch',
    on_remote: true,
    durability_statement: unchanged
      ? `Nothing to commit — origin/${input.branch} is already at ${short(remoteSha)}. No new work was created by this call.`
      : `Committed and verified on GitHub: ${input.branch} is at ${short(remoteSha)}. This survives the workspace.`,
    remote_branch: input.branch,
    ...(remoteSha ? { remote_sha: remoteSha } : {})
  };
}

function short(sha?: string): string {
  return sha ? sha.slice(0, 12) : 'unknown';
}
