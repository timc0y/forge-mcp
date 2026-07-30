import { ForgeError } from '@forge/core';
import { listSlotOccupants, slotTtlMs, TERMINAL_STATES, type SlotOccupant } from './capacity';
import type { Env } from './env';

interface Identity { tenantId: string }

/**
 * What a call means when it does not carry an opaque workspace id.
 *
 * `workspace` is ONE optional string — a freshly returned `ws_...` recovery
 * handle, `"owner/repo#branch"`, `"owner/repo"`, or a bare `"forge/..."`
 * branch — not three separate fields. Three optional
 * fields cost roughly 353 bytes per tool once emitted as JSON schema (type +
 * minLength + maxLength + description, times three) against 157 for one;
 * across the 25 converted tools that is ~4,900 bytes added to a catalog that
 * is re-sent every turn, which is the regression this whole redesign exists
 * to prevent. See parseWorkspaceAddress for the parsing rules.
 *
 * `workspaceId` stays on this type only for forge_artifact_get: an artifact's
 * owning workspace is handed back in the SAME response that returned the
 * artifact_id (forge_review's `workspaceId`, forge_shell's `output_artifact_id`
 * owner, etc.), so both ids are already in the model's immediate context
 * together — there is no multi-turn carry problem to solve there. It also
 * covers forge_review's url-review workspaces, which have no repository or
 * branch at all (fact: they mint a synthetic id with no Durable Object — see
 * migrations/d1/0011) and so can never be found by owner/repo/branch. When
 * given, it is trusted verbatim, exactly as the old single-string `provided`
 * parameter was.
 */
interface WorkspaceAddress {
  workspaceId?: unknown;
  workspace?: unknown;
}

interface ParsedAddress {
  owner?: string;
  repo?: string;
  branch?: string;
}

function normalize(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const WORKSPACE_ID_RE = /^ws_[0-9a-hjkmnp-tv-z]{20,32}$/u;
const WORKSPACE_ADDRESS_FORMS = 'a returned "ws_..." handle, "owner/repo#branch", "owner/repo", or a bare branch like "forge/fix-login"';

export function isWorkspaceId(value: string): boolean {
  return WORKSPACE_ID_RE.test(value.trim());
}

function malformedWorkspaceAddress(raw: string): ForgeError {
  return new ForgeError({
    code: 'FORGE_VALIDATION_FAILED',
    message: `workspace must be ${WORKSPACE_ADDRESS_FORMS} — e.g. "acme/webapp#forge/fix-login", "acme/webapp", or "forge/fix-login". Use one of those forms instead of "${raw}".`,
    retryable: false
  });
}

// owner/repo has exactly one '/', both sides non-empty. GitHub owner and repo
// names never contain '/' themselves, so this is unambiguous whenever it
// matches.
function parseOwnerRepo(value: string): { owner: string; name: string } | undefined {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash !== value.lastIndexOf('/') || slash === value.length - 1) return undefined;
  const owner = value.slice(0, slash);
  const name = value.slice(slash + 1);
  return owner && name ? { owner, name } : undefined;
}

/**
 * Parse the `workspace` field into owner/repo/branch. Exported so
 * forge_merge can read the branch half of what was given without resolving a
 * second time (see mcp-session.ts).
 *
 * Splits on the LAST `#` — verified safe rather than assumed: every branch
 * Forge ever creates matches packages/policy/src/branch-policy.ts's
 * `assertForgeBranch`, whose pattern (`^forge\/[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$`)
 * does not admit `#` at all, so a branch can never itself contain one — the
 * only `#` in a well-formed address is the owner/repo-branch separator.
 *
 * Without a `#`, "owner/repo" and a bare branch are told apart by the same
 * fact: every real branch starts with `forge/` (that policy again), so a
 * value starting with `forge/` is read as a branch, anything else with
 * exactly one `/` as owner/repo. (A GitHub owner literally named "forge"
 * would collide with this — pass `owner/repo#branch` explicitly to route
 * around it.)
 */
export function parseWorkspaceAddress(raw: string): ParsedAddress {
  const value = raw.trim();
  const hashIndex = value.lastIndexOf('#');
  if (hashIndex !== -1) {
    const repoPart = value.slice(0, hashIndex);
    const branchPart = value.slice(hashIndex + 1).trim();
    const repo = parseOwnerRepo(repoPart);
    if (!repo || !branchPart) throw malformedWorkspaceAddress(raw);
    return { owner: repo.owner, repo: repo.name, branch: branchPart };
  }
  if (value.startsWith('forge/')) return { branch: value };
  const repo = parseOwnerRepo(value);
  if (repo) return { owner: repo.owner, repo: repo.name };
  throw malformedWorkspaceAddress(raw);
}

function candidateLabel(occupant: SlotOccupant): string {
  const repo = occupant.repository ? `${occupant.repository.owner}/${occupant.repository.name}` : 'unknown/unknown';
  return `${repo} on ${occupant.currentBranch ?? 'no branch yet'}`;
}

function describeAddress(owner?: string, repo?: string, branch?: string): string {
  const parts: string[] = [];
  if (owner ?? repo) parts.push(`${owner ?? 'any owner'}/${repo ?? 'any repo'}`);
  if (branch) parts.push(`branch ${branch}`);
  return parts.length ? parts.join(', ') : 'the given address';
}

/**
 * Work out which workspace a call means when the caller did not say.
 *
 * An agent threads an opaque workspace_id through every call without effort. A
 * chat session does not: the id scrolls out of context, or a turn drops it, and
 * from then on every workspace tool fails — or worse, the model creates a
 * second workspace, burns a slot and leaves the first one running with the
 * actual work in it. `forge/fix-login on acme/webapp` survives summarisation
 * the way `ws_6afdde4ddbc58a7f089df28f89` never does, because it means
 * something — so Forge resolves by owner/repo/branch instead of asking the
 * model to remember a handle.
 *
 * Resolution order:
 *   1. All three given (`owner/repo#branch`) — resolve that exact (tenant,
 *      repository, branch). The partial unique index in migrations/d1 (see
 *      0027_workspace_addressing_uniqueness.sql) guarantees at most one live
 *      match.
 *   2. Branch alone (a bare `forge/...` string) — resolve if it is
 *      unambiguous across every live workspace this tenant has open,
 *      regardless of repository.
 *   3. Nothing given — resolve if the tenant has exactly one live workspace.
 *   4. Owner/repo without a match, or more than one live workspace satisfies
 *      whatever WAS given — refuse and name the candidates as
 *      `owner/repo on branch`, never as `ws_...`: that id is exactly what a
 *      chat session has already lost, so an error that repeats it back is not
 *      answerable.
 *
 * Deliberately only resolves when there is no ambiguity at all for the given
 * filters. Acting on the wrong workspace is worse than asking.
 */
export async function resolveWorkspaceId(env: Env, identity: Identity, address: WorkspaceAddress): Promise<string> {
  const explicit = normalize(address.workspaceId);
  if (explicit) return explicit;

  const raw = normalize(address.workspace);
  // A non-blocking create has no branch until provisioning reaches the branch
  // step, so its returned workspace id is the only immediately usable recovery
  // address. authorizedCoordinator still verifies tenant/project ownership;
  // the opaque id is a locator, never authorization.
  if (raw && isWorkspaceId(raw)) return raw;
  const parsed: ParsedAddress = raw ? parseWorkspaceAddress(raw) : {};
  const { owner, repo, branch } = parsed;

  let occupants: Awaited<ReturnType<typeof listSlotOccupants>>;
  try {
    occupants = await listSlotOccupants(env.METADATA, slotTtlMs(env), Date.now(), identity.tenantId);
  } catch (error) {
    const cause = error instanceof Error
      ? error.message.slice(0, 1_000)
      : typeof error === 'string'
        ? error.slice(0, 1_000)
        : 'The workspace registry returned an unknown failure.';
    const nextAction = 'Retry the same call once. Do not create another workspace: Forge could not determine whether one is already open.';
    throw new ForgeError({
      code: 'FORGE_PROVIDER_UNAVAILABLE',
      message: 'Forge could not query the workspace registry, so it cannot safely choose a workspace. Retry the same call once; do not create another workspace because Forge could not determine whether one is already open.',
      retryable: true,
      details: { cause, nextAction }
    });
  }
  const live = occupants.filter((occupant) => occupant.state !== null && !TERMINAL_STATES.includes(occupant.state));

  let candidates = live;
  if (owner !== undefined) candidates = candidates.filter((occupant) => occupant.repository?.owner === owner);
  if (repo !== undefined) candidates = candidates.filter((occupant) => occupant.repository?.name === repo);
  if (branch !== undefined) candidates = candidates.filter((occupant) => occupant.currentBranch === branch);

  if (candidates.length === 1) return candidates[0]!.workspaceId;

  if (candidates.length === 0) {
    if (owner === undefined && repo === undefined && branch === undefined) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: 'No workspace is open. Call forge_workspace_create first — it returns one ready to use — then future calls find it automatically, or by workspace: "owner/repo#branch".',
        retryable: false
      });
    }
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `No live workspace matches ${describeAddress(owner, repo, branch)}. Call forge_observer_workspaces to see what is actually open, or forge_workspace_create to start one.`,
      retryable: false,
      details: { owner: owner ?? null, repo: repo ?? null, branch: branch ?? null }
    });
  }

  throw new ForgeError({
    code: 'FORGE_VALIDATION_FAILED',
    message: `Several workspaces are open, so this is ambiguous. Pass workspace as "owner/repo#branch" to say which — one of: ${candidates.map(candidateLabel).join(', ')}.`,
    retryable: false,
    details: { workspaces: candidates.map((occupant) => ({ owner: occupant.repository?.owner ?? null, repo: occupant.repository?.name ?? null, branch: occupant.currentBranch ?? null })) }
  });
}
