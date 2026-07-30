export {
  deleteGitHubBranchIfUnchanged,
  listAllGitHubBranches,
  listGitHubBranchesWithinBudget,
  readGitHubBranch
} from './github-repository';

/** Branches still owned by a live workspace and therefore unsafe to delete. */
export function liveWorkspaceBranches(
  occupants: Array<{ repository: { owner: string; name: string } | null; currentBranch: string | null; state: string | null }>,
  owner: string,
  repo: string,
  terminalStates: readonly string[]
): Set<string> {
  return new Set(
    occupants
      .filter((occupant) =>
        occupant.repository?.owner.toLowerCase() === owner.toLowerCase() &&
        occupant.repository.name.toLowerCase() === repo.toLowerCase() &&
        occupant.currentBranch !== null &&
        occupant.state !== null &&
        !terminalStates.includes(occupant.state)
      )
      .map((occupant) => occupant.currentBranch as string)
  );
}
