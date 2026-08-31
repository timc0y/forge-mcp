/**
 * The shared vocabulary. Every module implements against these types; nothing
 * here has behaviour, so a change to this file is a change to the design.
 *
 * Three nouns exist: a repository, a change, and a capture. There is no
 * workspace, no session state, and no identifier the chat has to remember.
 */

/** Who is calling. Resolved per request; never cached across users. */
export interface Identity {
  userId: string;
  githubLogin: string;
  /** The user's own GitHub App installation. Their rate limit, not ours. */
  installationId: string;
}

export interface RepoRef {
  owner: string;
  name: string;
}

/** `owner/name`, the only repository address that appears in a tool result. */
export function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

/**
 * One shape for every GitHub call, so no module builds its own client.
 * `accept` selects a media type — `application/vnd.github.diff` returns a
 * unified diff in `text` with `json` left null.
 */
export type GitHubRequest = (
  path: string,
  init?: { method?: string; body?: unknown; accept?: string }
) => Promise<{ status: number; json: unknown; text: string; headers: Headers }>;

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/**
 * A change is Forge's fixed branch and its draft pull request.
 */
export interface Change {
  /** The human-readable name. New changes are simply "forge". */
  name: string;
  /** `forge` for new changes. Older open changes may retain `forge/*`. */
  branch: string;
  /** Pull request number once one is open. */
  number: number | null;
  /** True while the change is still being worked on rather than asking to land. */
  draft: boolean;
  /** When the change last moved, so a list of them reads newest-first to a human. */
  updatedAt: string;
  /**
   * Size, present only when something actually compared. Listing open changes
   * runs on every tool result and GitHub's list-pulls payload carries no diff
   * stats, so filling these would cost one extra request per change, every
   * turn. Absent means unmeasured — never zero standing in for unknown.
   */
  stats?: {
    aheadBy: number;
    behindBy: number;
    filesChanged: number;
    additions: number;
    deletions: number;
  };
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  /** Present only when the caller asked about this path. */
  patch?: string;
}

/**
 * The answer to every question about difference, from one `compare` call.
 * `status` also decides whether a change is safe to discard: `identical` or
 * `behind` means nothing unmerged would be lost.
 */
export interface Comparison {
  status: 'identical' | 'ahead' | 'behind' | 'diverged';
  aheadBy: number;
  behindBy: number;
  files: ChangedFile[];
  /** GitHub caps the file list. Say so rather than letting it read as complete. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * `content` writes a whole file and is meant for new or small ones; `null`
 * deletes. `replace` edits an existing file by unambiguous fragment — a match
 * that is absent or repeated is refused rather than guessed at.
 */
export interface FileWrite {
  path: string;
  content?: string | null;
  replace?: Array<{ old: string; new: string; all?: boolean }>;
}

/**
 * Proof the work is on GitHub. No success result may exist without one, because
 * the gap between "the edit landed" and "the edit is on origin" is where this
 * project's worst failures lived.
 */
export interface CommitReceipt {
  repo: string;
  branch: string;
  sha: string;
  url: string;
  /** An identical tree makes no commit and says so, rather than faking one. */
  outcome: 'committed' | 'unchanged';
  paths: string[];
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Every tool result carries the repository's open Forge change. This replaces
 * client memory. Nothing else in the system stores conversational state.
 */
export interface Receipt<T> {
  value: T;
  openChanges: Change[];
  /** What was not done, in plain words. Never omitted to make a result look clean. */
  limitations?: string[];
  /** At most one, and it must name a tool that exists. */
  nextStep?: string;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export type ApprovalAct = 'merge' | 'discard';

/**
 * An approval the human can act on later, from a different device, after the
 * chat has ended. The evidence travels with it because an approval with nothing
 * to judge is theatre.
 */
export interface ApprovalRequest {
  act: ApprovalAct;
  repo: RepoRef;
  change: Change;
  comparison: Comparison;
  /** The head this decision was made against; a moved head invalidates it. */
  headSha: string;
  /** The default-branch destination shown to the human when approval was minted. */
  baseBranch?: string;
}

export interface ApprovalReceipt {
  act: ApprovalAct;
  url: string;
  expiresAt: string;
  summary: string;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export type Viewport = 'phone' | 'tablet' | 'desktop';

export const VIEWPORT_SIZES: Record<Viewport, { width: number; height: number }> = {
  phone: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  desktop: { width: 1440, height: 900 }
};

export interface CaptureImage {
  viewport: Viewport;
  /** Base64 PNG, returned inline with the call that asked for it. */
  base64: string;
  bytes: number;
}

export interface Capture {
  url: string;
  images: CaptureImage[];
  title: string;
  /**
   * Bounded, human-readable lines derived from the accessibility tree. The raw
   * tree stays internal: this is enough structure for the model without paying
   * the context cost of every browser node and state field.
   */
  outline: string[];
  outlineTruncated: boolean;
  /** Accessibility tree, retained only for code that needs the source shape. */
  structure?: unknown;
  /** Viewports that failed, and why. Partial evidence beats none. */
  failures: Array<{ viewport: Viewport; reason: string }>;
}
