/**
 * The five tools, and nothing else.
 *
 * The client is an ordinary ChatGPT conversation, often on a phone. It cannot
 * loop, poll, or reliably carry an identifier across a summarised turn, so
 * three rules shape every handler below and none of them is negotiable:
 *
 * 1. Each result is useful on its own. Nothing here tells the model to wait,
 *    poll, retry something that already happened, or call a tool that does not
 *    exist. The one continuation Forge has is an approval URL a human opens,
 *    and it outlives the conversation.
 * 2. Each result carries the repository's open Forge change. That replaces
 *    client memory. Nothing here returns a pull-request number that the model
 *    could try to pass back.
 * 3. Output schemas stay small. The catalog is re-sent on every turn, before
 *    the model reads a single word of the conversation, so a field that only
 *    restates an input or an internal id is a tax paid on every message.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  Change,
  ChangedFile,
  Comparison,
  GitHubRequest,
  Identity,
  RepoRef,
  Viewport
} from './contracts';
import { formatRepo } from './contracts';
import type { Env } from './env';
import { ForgeError, isForgeError, toForgeError } from './errors';
import { parseRepo } from './github';
import { compare, listRepos, readFiles, readTree } from './read';
import { CHANGE_BRANCH, ensureDraftPullRequest, findChange, openChanges, openChangesTruncated } from './change';
import { commitFiles } from './write';
import { assertNotNearExisting, createRepo, defaultBranch } from './repo';
import { capture } from './capture';
import { storeGallery } from './gallery';
import { releaseCaptureQuota, reserveCaptureQuota } from './quota';
import { requestApproval } from './approve';
import type { Analytics } from './analytics';

export interface ToolContext {
  env: Env;
  identity: Identity;
  /** Fire-and-forget. Never awaited, never able to fail a call. */
  track: Analytics;
  /** The user's own installation. Everything that touches a repository. */
  gh: GitHubRequest;
  /** Authenticated as the human. Only creating a repository needs it. */
  ghUser: GitHubRequest;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * All four are chat budgets, not GitHub limits. A phone conversation that
 * receives a thousand paths has received nothing it can read, and the honest
 * move is to cap and say so rather than to send a wall the host truncates
 * silently at some unknown point.
 */
const MAX_REPOS = 50;
const MAX_TREE_ENTRIES = 300;
const MAX_DIFF_FILES = 200;
const MAX_FILE_BYTES = 64 * 1024;

const DEFAULT_VIEWPORTS: Viewport[] = ['phone', 'desktop'];

/**
 * Total base64 image bytes one result may carry.
 *
 * Every other budget here protects the model's context; this one also protects
 * the transport. Three 2x captures of an image-heavy page are megabytes, and a
 * host that rejects or truncates an oversized payload throws away evidence the
 * quota has already been spent on. Dropping a viewport and saying so is the
 * only outcome that stays honest.
 */
const MAX_IMAGE_BYTES = 1_500_000;

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

/** The content types Forge actually emits. Images only ever come from capture. */
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

interface ToolOutcome {
  /** One line, readable on its own — some hosts show only this. */
  summary: string;
  structured: Record<string, unknown>;
  /** Extra content blocks, appended after the summary. */
  content?: Content[];
}

/**
 * The three fields every tool shares. `changes` is the open-changes list —
 * present whenever a repository is in scope, absent when there is no
 * repository to have changes, never faked as an empty list.
 */
const receiptFields = {
  changes: z.array(z.string()).optional(),
  limits: z.array(z.string()).optional(),
  next: z.string().optional()
};

/** Only attach a list when it has something in it; an empty array is noise. */
function withLimits(structured: Record<string, unknown>, limits: string[]): Record<string, unknown> {
  return limits.length > 0 ? { ...structured, limits } : structured;
}

/**
 * Every handler runs through here, so no raw throw can reach the transport and
 * no terminal failure can arrive wrapped in a success envelope: a failure is
 * `isError` with the code and the message, and nothing else.
 */
async function run(
  tool: string,
  track: Analytics,
  work: () => Promise<ToolOutcome>
): Promise<{
  content: Content[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  const started = Date.now();
  try {
    const outcome = await work();
    track('tool_called', { tool, ok: true, ms: Date.now() - started });
    return {
      structuredContent: outcome.structured,
      content: [{ type: 'text', text: outcome.summary }, ...(outcome.content ?? [])]
    };
  } catch (thrown) {
    const error = toForgeError(thrown);
    // The code, never the message: a message can carry a path or a repository
    // name, and analytics is not where the user's work belongs.
    track('tool_called', { tool, ok: false, code: error.code, ms: Date.now() - started });
    if (error.code === 'FORGE_QUOTA_EXCEEDED') track('quota_refused', { tool });
    // Code and tool only: an error message can carry file contents or a repo
    // name, and this line goes to a log Forge's operators read, not the user.
    console.error('forge_tool_failed', { tool, code: error.code });
    // No structuredContent on failure. The SDK validates it whenever it is
    // present — even on an error — so declaring an `error` field on all five
    // output schemas was the price of returning one. It is omitted instead:
    // the model reads the text block, and the catalog stops carrying 770 bytes
    // per turn to describe a shape that only appears when something broke.
    return {
      isError: true,
      content: [{ type: 'text', text: `${error.code}: ${error.message}` }]
    };
  }
}

// ---------------------------------------------------------------------------
// Shared resolution
// ---------------------------------------------------------------------------

/**
 * `owner/name`, or a bare name meaning the caller's own account. A phone
 * conversation says "my notes repo", not "timcoy/notes", and refusing the bare
 * form would put ceremony back exactly where this product removed it.
 */
function resolveRepo(ctx: ToolContext, value: string): RepoRef {
  const trimmed = value.trim();
  return parseRepo(trimmed.includes('/') ? trimmed : `${ctx.identity.githubLogin}/${trimmed}`);
}

function changeNames(changes: Change[]): string[] {
  return changes.map((change) => change.name);
}

/**
 * The open-changes list is one page. Everywhere else in this file a cap is
 * disclosed, and this list is the one the model trusts most — it is what
 * replaces its memory — so a silent short list is the worst place to keep quiet.
 */
function changesLimits(changes: Change[]): string[] {
  return openChangesTruncated(changes)
    ? [`Only the ${changes.length} most recent open changes are listed; this repository has more.`]
    : [];
}

/** For a summary line: "Open changes: a, b." or nothing at all. */
function changesSentence(names: string[]): string {
  return names.length === 0 ? '' : ` Open changes: ${names.join(', ')}.`;
}

/**
 * The head this decision is being made against. An approval stores it so that
 * a branch which moves before the human clicks invalidates the decision rather
 * than silently landing something they never saw.
 */
async function headSha(gh: GitHubRequest, repo: RepoRef, branch: string): Promise<string> {
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  const response = await gh(`/repos/${repo.owner}/${repo.name}/git/ref/heads/${ref}`);
  if (response.status !== 200) {
    throw new ForgeError({
      code: response.status === 404 ? 'FORGE_NOT_FOUND' : 'FORGE_UPSTREAM_UNAVAILABLE',
      message: `GitHub did not return the head of ${branch} on ${formatRepo(repo)} (HTTP ${response.status}).`,
      retryable: response.status >= 500
    });
  }
  const sha = (response.json as { object?: { sha?: string } } | null)?.object?.sha;
  if (!sha) {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: `GitHub returned no commit for ${branch} on ${formatRepo(repo)}.`,
      retryable: true
    });
  }
  return sha;
}

function totals(comparison: Comparison): { files: number; additions: number; deletions: number } {
  return comparison.files.reduce(
    (sum, file) => ({
      files: sum.files + 1,
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions
    }),
    { files: 0, additions: 0, deletions: 0 }
  );
}

/** "modified +12/-3" — status and size in one field rather than three. */
function describeChangedFile(file: ChangedFile): string {
  return `${file.status} +${file.additions}/-${file.deletions}`;
}

// ---------------------------------------------------------------------------
// forge_read
// ---------------------------------------------------------------------------

const readOutput = {
  repos: z.array(z.object({ repo: z.string(), about: z.string() })).optional(),
  tree: z.array(z.string()).optional(),
  files: z.array(z.object({ path: z.string(), text: z.string() })).optional(),
  diff: z
    .object({
      status: z.enum(['identical', 'ahead', 'behind', 'diverged']),
      ahead: z.number(),
      behind: z.number(),
      files: z.array(z.object({ path: z.string(), change: z.string(), patch: z.string().optional() }))
    })
    .optional(),
  ...receiptFields
};

async function readRepositories(ctx: ToolContext, query: string | undefined): Promise<ToolOutcome> {
  const found = await listRepos(ctx.gh, query);
  // Newest push first: recency is the only ordering a human recognises in a
  // list of their own repositories.
  const sorted = [...found].sort((left, right) => right.pushedAt.localeCompare(left.pushedAt));
  const shown = sorted.slice(0, MAX_REPOS);

  const limits: string[] = [];
  if (sorted.length > shown.length) {
    limits.push(`Showing ${shown.length} of ${sorted.length} repositories. Pass query to narrow the list.`);
  }

  if (shown.length === 0) {
    return {
      summary: query
        ? `No repository Forge can reach matches "${query}".`
        : 'Forge cannot reach any repository for this account yet.',
      structured: withLimits(
        { repos: [], next: 'forge_edit creates a repository by writing the first file into it.' },
        limits
      )
    };
  }

  return {
    summary: `${shown.length} repositor${shown.length === 1 ? 'y' : 'ies'}: ${shown
      .map((entry) => entry.repo)
      .join(', ')}.`,
    structured: withLimits(
      {
        repos: shown.map((entry) => ({
          repo: entry.repo,
          about: [entry.description, entry.private ? 'private' : 'public', `pushed ${entry.pushedAt.slice(0, 10)}`]
            .filter((part): part is string => Boolean(part))
            .join(' · ')
        })),
        next: 'Name one to see its files and open changes.'
      },
      limits
    )
  };
}

async function readTreeLevel(
  ctx: ToolContext,
  repo: RepoRef,
  query: string | undefined
): Promise<ToolOutcome> {
  const base = await defaultBranch(ctx.gh, repo);
  const [tree, changes] = await Promise.all([
    readTree(ctx.gh, repo, base),
    openChanges(ctx.gh, repo)
  ]);

  const needle = query?.trim().toLowerCase();
  // Directories are redundant in a recursive listing: every one of them is
  // already spelled out inside the paths of the files it holds.
  const paths = tree.entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => entry.path)
    .filter((path) => (needle ? path.toLowerCase().includes(needle) : true));
  const shown = paths.slice(0, MAX_TREE_ENTRIES);

  const limits: string[] = [];
  if (paths.length > shown.length) {
    limits.push(`Showing ${shown.length} of ${paths.length} files. Pass query to narrow the list.`);
  }
  if (tree.truncated) {
    limits.push('GitHub truncated this listing, so some files are missing from it.');
  }

  const names = changeNames(changes);
  return {
    summary: `${formatRepo(repo)} at ${base}: ${shown.length} file${shown.length === 1 ? '' : 's'}.${changesSentence(names)}`,
    structured: withLimits(
      {
        tree: shown,
        changes: names,
        next:
          names.length > 0
            ? 'Say a change name to see what it did.'
            : 'Ask for paths to read any of these files.'
      },
      limits
    )
  };
}

async function readFilesLevel(ctx: ToolContext, repo: RepoRef, paths: string[]): Promise<ToolOutcome> {
  const base = await defaultBranch(ctx.gh, repo);
  const [read, changes] = await Promise.all([
    readFiles(ctx.gh, repo, base, paths, MAX_FILE_BYTES),
    openChanges(ctx.gh, repo)
  ]);

  const names = changeNames(changes);
  return {
    summary: `${read.files.length} of ${paths.length} file${paths.length === 1 ? '' : 's'} from ${formatRepo(repo)} at ${base}.${changesSentence(names)}`,
    structured: withLimits(
      {
        files: read.files.map((file) => ({ path: file.path, text: file.content })),
        changes: names,
        next: 'forge_edit writes these back on a change of its own.'
      },
      read.skipped.map((skip) => `${skip.path} ${skip.reason}.`)
    )
  };
}

async function readChangeLevel(
  ctx: ToolContext,
  repo: RepoRef,
  wanted: string,
  paths: string[] | undefined
): Promise<ToolOutcome> {
  const base = await defaultBranch(ctx.gh, repo);
  const change = await findChange(ctx.gh, repo, wanted);
  const comparison = await compare(ctx.gh, repo, base, change.branch, paths);

  const limits: string[] = [];
  const asked = new Set(paths ?? []);
  for (const path of asked) {
    if (!comparison.files.some((file) => file.path === path)) {
      limits.push(`${path} is not touched by "${change.name}".`);
    }
  }

  // Files the caller asked about come first, so a cap can never be what
  // removes the one patch they were looking for.
  const ordered = [
    ...comparison.files.filter((file) => asked.has(file.path)),
    ...comparison.files.filter((file) => !asked.has(file.path))
  ];
  const shown = ordered.slice(0, MAX_DIFF_FILES);
  if (ordered.length > shown.length) {
    limits.push(`Showing ${shown.length} of ${ordered.length} changed files.`);
  }
  if (comparison.truncated) {
    limits.push('GitHub truncated this comparison, so some changed files are missing from it.');
  }

  const size = totals(comparison);
  const changes = await openChanges(ctx.gh, repo);
  const names = changeNames(changes);

  return {
    summary: `"${change.name}" is ${comparison.status} against ${base}: ${size.files} file${size.files === 1 ? '' : 's'}, +${size.additions}/-${size.deletions}.${changesSentence(names)}`,
    structured: withLimits(
      {
        diff: {
          status: comparison.status,
          ahead: comparison.aheadBy,
          behind: comparison.behindBy,
          files: shown.map((file) => ({
            path: file.path,
            change: describeChangedFile(file),
            ...(file.patch === undefined ? {} : { patch: file.patch })
          }))
        },
        changes: names,
        next:
          asked.size > 0
            ? 'When this is right, forge_merge asks a human to land it.'
            : 'Ask for paths to see their patches.'
      },
      limits
    )
  };
}

// ---------------------------------------------------------------------------
// forge_edit
// ---------------------------------------------------------------------------

/**
 * Resolve the repository to write into, creating it if this is the first time
 * anyone has written there. Repo creation is the only irreversible thing "no
 * ceremony" touches, so it is fenced twice: only on the caller's own account,
 * and never onto a name that is a near-miss of one they already have.
 */
async function resolveWriteTarget(
  ctx: ToolContext,
  repo: RepoRef,
  description: string,
  wantPrivate: boolean
): Promise<{ base: string; created: boolean }> {
  try {
    return { base: await defaultBranch(ctx.gh, repo), created: false };
  } catch (thrown) {
    if (!isForgeError(thrown) || thrown.code !== 'FORGE_NOT_FOUND') throw thrown;

    if (repo.owner.toLowerCase() !== ctx.identity.githubLogin.toLowerCase()) {
      throw new ForgeError({
        code: 'FORGE_NOT_FOUND',
        message:
          `Forge cannot reach ${formatRepo(repo)}, and it only creates repositories on your own account ` +
          `(${ctx.identity.githubLogin}). Install the Forge GitHub App on ${repo.owner} if it should be reachable.`,
        details: { repo: formatRepo(repo) }
      });
    }

    // Compared against every repository Forge can reach, not just this owner's:
    // a typo of an organisation's repo name would otherwise quietly create a
    // personal orphan that looks right and that nobody else ever looks at.
    const reachable = await listRepos(ctx.gh);

    // The repository may exist and simply not be visible to the endpoint that
    // 404'd a moment ago — GitHub's own consistency, not ours. Creating a
    // second one would be the worst possible reading of that, and an exact
    // name match is the caller's repository rather than a near miss of it.
    const exact = reachable.find(
      (entry) => entry.repo.toLowerCase() === `${repo.owner}/${repo.name}`.toLowerCase()
    );
    if (exact) return { base: exact.defaultBranch, created: false };

    assertNotNearExisting(repo.name, [...new Set(reachable.map((entry) => entry.repo.split('/')[1] ?? entry.repo))]);

    const created = await createRepo(ctx.ghUser, repo.name, { private: wantPrivate, description });
    try {
      return { base: await defaultBranch(ctx.gh, created), created: true };
    } catch {
      // The repository exists now. Saying so — and that the same call will work
      // — is the only honest report: the create is done and must not repeat.
      throw new ForgeError({
        code: 'FORGE_UPSTREAM_UNAVAILABLE',
        message: `Created ${formatRepo(created)}, but Forge cannot see it yet. Send this same edit again.`,
        retryable: true,
        details: { repo: formatRepo(created) }
      });
    }
  }
}

const fileInput = z.object({
  path: z.string(),
  content: z.string().nullable().optional().describe('Whole file. null deletes it.'),
  replace: z
    .array(z.object({ old: z.string(), new: z.string(), all: z.boolean().optional() }))
    .optional()
    .describe('Edit by unambiguous fragment instead of resending the file.')
});

// ---------------------------------------------------------------------------
// forge_merge and forge_discard
// ---------------------------------------------------------------------------

const approvalOutput = {
  approval: z.object({ url: z.string(), expires: z.string() }).optional(),
  evidence: z.string().optional(),
  ...receiptFields
};

/**
 * Both acts follow one path because both are the same shape of decision: read
 * the evidence, freeze it, hand back one link. They stay two tools because an
 * approval card must never be ambiguous about which act it is authorizing.
 */
async function requestAct(
  ctx: ToolContext,
  act: 'merge' | 'discard',
  repoInput: string,
  wanted: string
): Promise<ToolOutcome> {
  const repo = resolveRepo(ctx, repoInput);
  const base = await defaultBranch(ctx.gh, repo);
  const change = await findChange(ctx.gh, repo, wanted);
  const comparison = await compare(ctx.gh, repo, base, change.branch);
  const head = await headSha(ctx.gh, repo, change.branch);
  const size = totals(comparison);

  // `change` goes in as it came out of GitHub, without `stats` copied onto it:
  // the comparison stored beside it already carries those numbers, and a
  // second copy of a measurement is a second thing that can disagree.
  const approval = await requestApproval(ctx.env, ctx.identity, {
    act,
    repo,
    change,
    comparison,
    headSha: head,
    baseBranch: base
  });
  ctx.track('approval_requested', {
    act,
    files: size.files,
    commits: comparison.aheadBy,
    truncated: comparison.truncated
  });

  // The one fact each decision turns on, stated in the result rather than only
  // on the approval page: a human may read this summary and never open the link.
  const commits = `${comparison.aheadBy} commit${comparison.aheadBy === 1 ? '' : 's'}`;
  const files = `${size.files} file${size.files === 1 ? '' : 's'}, +${size.additions}/-${size.deletions}`;
  const loss =
    comparison.aheadBy === 0
      ? `Nothing unmerged would be lost: every commit is already on ${base}.`
      : `${commits} would stop being reachable.`;
  const evidence =
    act === 'merge'
      ? `Merging "${change.name}" into ${base} brings ${commits}: ${files}.`
      : `Discarding "${change.name}" drops ${files}. ${loss}`;

  const limits: string[] = [];
  if (comparison.truncated) {
    limits.push('GitHub truncated this comparison, so the file counts above are a floor, not a total.');
  }
  if (act === 'merge' && comparison.behindBy > 0) {
    limits.push(`This change is ${comparison.behindBy} commit${comparison.behindBy === 1 ? '' : 's'} behind ${base}; GitHub decides at merge time whether it still applies cleanly.`);
  }

  const changes = await openChanges(ctx.gh, repo);
  return {
    summary: `${evidence} Nothing has happened yet — open ${approval.url} to decide.`,
    structured: withLimits(
      {
        approval: { url: approval.url, expires: approval.expiresAt },
        evidence,
        changes: changeNames(changes),
        next: `Open the link and confirm. Forge performs the ${act} at that moment, even if this chat has ended.`
      },
      limits
    )
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'forge_read',
    {
      title: 'Read',
      description:
        'Show what is there. No repo lists your repositories; a repo shows its files and open changes; adding a change shows what that change did; adding paths returns file contents, or that change\'s patch for those paths.',
      inputSchema: {
        repo: z.string().optional().describe('owner/name. Omit to list your repositories.'),
        change: z.string().optional().describe('An open change, named by the words that created it.'),
        paths: z.array(z.string()).max(20).optional(),
        query: z.string().optional().describe('Narrows the repository list, or the file list.')
      },
      outputSchema: readOutput,
      // Nothing here writes, and it reaches nothing but GitHub.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: {
        'openai/toolInvocation/invoking': 'Reading GitHub…',
        'openai/toolInvocation/invoked': 'Read'
      }
    },
    async (input) =>
      run('forge_read', ctx.track, async () => {
        if (input.repo === undefined) {
          if (input.change !== undefined || input.paths !== undefined) {
            throw new ForgeError({
              code: 'FORGE_VALIDATION_FAILED',
              message: 'Say which repository, as owner/name. Call forge_read with no arguments to list them.'
            });
          }
          return readRepositories(ctx, input.query);
        }

        const repo = resolveRepo(ctx, input.repo);
        if (input.change !== undefined) return readChangeLevel(ctx, repo, input.change, input.paths);
        if (input.paths !== undefined && input.paths.length > 0) return readFilesLevel(ctx, repo, input.paths);
        return readTreeLevel(ctx, repo, input.query);
      })
  );

  server.registerTool(
    'forge_edit',
    {
      title: 'Edit',
      description:
        'Write files to GitHub. Commit ordinary plans, research, direction and routine content directly by omitting change. Set change only when the work should stay separate for human review; Forge then uses its one fixed branch. Creates the repository if needed. The commit is on GitHub before this returns.',
      inputSchema: {
        repo: z.string().describe('owner/name, or a bare name to create it on your account.'),
        change: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Why this work needs review before becoming repository truth. Omit for ordinary durable edits.'),
        files: z.array(fileInput).min(1).max(10),
        message: z.string().describe('Commit message saying what changed.'),
        private: z.boolean().optional().describe('Only read when the repository is created. Defaults to true.')
      },
      outputSchema: {
        commit: z
          .object({
            repo: z.string(),
            branch: z.string(),
            sha: z.string(),
            url: z.string(),
            outcome: z.enum(['committed', 'unchanged'])
          })
          .optional(),
        change: z.string().optional(),
        review: z.string().optional(),
        ...receiptFields
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: {
        'openai/toolInvocation/invoking': 'Saving to GitHub…',
        'openai/toolInvocation/invoked': 'Saved'
      }
    },
    async (input) =>
      run('forge_edit', ctx.track, async () => {
        const repo = resolveRepo(ctx, input.repo);
        const message = input.message.trim();
        const { base, created } = await resolveWriteTarget(ctx, repo, message, input.private ?? true);
        const change = input.change;
        const proposed = change !== undefined;
        const branch = proposed ? CHANGE_BRANCH : base;

        if (proposed && branch === base) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `${base} is both the default branch and Forge's reserved change branch in ${formatRepo(repo)}. Rename the default branch before proposing work.`,
            details: { branch }
          });
        }

        if (proposed) {
          const legacy = (await openChanges(ctx.gh, repo)).filter((change) => change.branch !== CHANGE_BRANCH);
          if (legacy.length > 0) {
            throw new ForgeError({
              code: 'FORGE_CONFLICT',
              message: `Resolve the older Forge change${legacy.length === 1 ? '' : 's'} first: ${changeNames(legacy).join(', ')}. Forge now keeps only one proposed change.`,
              details: { changes: changeNames(legacy) }
            });
          }
        }

        const commit = await commitFiles(
          ctx.gh,
          repo,
          branch,
          base,
          message,
          input.files
        );
        if (commit.outcome === 'committed') {
          ctx.track('change_committed', { files: commit.paths.length, created_repo: created });
        }
        // Everything past this line is decoration on work that is already on
        // GitHub, and none of it may throw.
        //
        // A failure here used to become `isError` with no commit, no branch and
        // no SHA — telling the model nothing landed when something did, whose
        // only sane response is to write again. A durable commit reported as a
        // terminal failure is the worst result this product can produce, so the
        // pull request and the change list degrade to limitations instead.
        const limits: string[] = [];

        let number: number | null = null;
        try {
          if (change !== undefined) number = await ensureDraftPullRequest(ctx.gh, repo, branch, change, base);
        } catch (error) {
          limits.push(
            `The work is committed, but its review pull request could not be opened: ${toForgeError(error).message} ` +
              'The branch exists on GitHub either way.'
          );
        }

        let changes: Change[] = [];
        try {
          changes = await openChanges(ctx.gh, repo);
        } catch {
          limits.push('The list of open changes could not be read just now, so it is omitted below.');
        }

        if (commit.outcome === 'unchanged') {
          limits.push('No commit was made: these files already had exactly this content.');

          // A branch with no commits ahead cannot have a pull request, so it
          // would never appear in the open-changes list and forge_discard
          // could never address it — a ref only Forge's own no-op created and
          // only a human on github.com could remove. Take it back.
          if (proposed && number === null) {
            const ref = branch.split('/').map(encodeURIComponent).join('/');
            const removed = await ctx.gh(`/repos/${repo.owner}/${repo.name}/git/refs/heads/${ref}`, {
              method: 'DELETE'
            });
            if (removed.status >= 200 && removed.status < 300) {
              limits.push('No Forge change was opened, because there was nothing to put in it.');
            }
          }
        }

        const createdNote = created ? `Created ${formatRepo(repo)}. ` : '';
        return {
          summary: `${createdNote}${commit.outcome === 'committed' ? 'Committed' : 'Already matched'} ${commit.paths.length} file${commit.paths.length === 1 ? '' : 's'} ${proposed ? 'on the Forge change' : `to ${base}`} in ${formatRepo(repo)} (${commit.sha.slice(0, 7)}).${changesSentence(changeNames(changes))}`,
          structured: withLimits(
            {
              commit: {
                repo: commit.repo,
                branch: commit.branch,
                sha: commit.sha,
                url: commit.url,
                outcome: commit.outcome
              },
              ...(proposed ? { change: 'forge' } : {}),
              ...(number === null
                ? {}
                : { review: `https://github.com/${repo.owner}/${repo.name}/pull/${number}` }),
              changes: changeNames(changes),
              next: proposed ? 'When this change is right, forge_merge asks a human to land it.' : 'The edit is now repository truth.'
            },
            limits
          )
        };
      })
  );

  server.registerTool(
    'forge_merge',
    {
      title: 'Merge',
      description:
        'Ask a human to land a change on the default branch. Returns one link that performs the merge when they approve it, and works after this chat ends. Merges nothing itself.',
      inputSchema: { repo: z.string(), change: z.string() },
      outputSchema: approvalOutput,
      // Destructive because the act it authorizes is: a landed merge moves the
      // default branch and cannot be taken back from a chat.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: {
        'openai/toolInvocation/invoking': 'Preparing the merge…',
        'openai/toolInvocation/invoked': 'Approval ready'
      }
    },
    async (input) => run('forge_merge', ctx.track, () => requestAct(ctx, 'merge', input.repo, input.change))
  );

  server.registerTool(
    'forge_discard',
    {
      title: 'Discard',
      description:
        'Ask a human to throw a change away. Returns one link that closes it and deletes its branch when they approve, stating first whether any unmerged commits would be lost. Discards nothing itself.',
      inputSchema: { repo: z.string(), change: z.string() },
      outputSchema: approvalOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: {
        'openai/toolInvocation/invoking': 'Preparing the discard…',
        'openai/toolInvocation/invoked': 'Approval ready'
      }
    },
    async (input) => run('forge_discard', ctx.track, () => requestAct(ctx, 'discard', input.repo, input.change))
  );

  server.registerTool(
    'forge_see',
    {
      title: 'See',
      description:
        'Screenshot a page that is already public, at phone and desktop unless told otherwise. The images come back with this call; there is nothing to fetch afterwards.',
      inputSchema: {
        url: z.string().describe('A public http(s) URL. Private and local addresses are refused.'),
        viewports: z.array(z.enum(['phone', 'tablet', 'desktop'])).max(3).optional()
      },
      outputSchema: {
        page: z.object({ url: z.string(), title: z.string(), shown: z.array(z.string()) }).optional(),
        gallery: z.string().optional().describe('A link to these images that works in any client, and later.'),
        quota: z.string().optional(),
        // Not the shared receipt fields: a capture has no repository, so it has
        // no open changes and no next tool worth naming. Declaring either would
        // be schema the handler never fills, re-sent on every turn.
        limits: z.array(z.string()).optional()
      },
      // Read-only against the world it reaches: it renders a page and changes
      // nothing on it. openWorld because that page is any host the user names.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: {
        'openai/toolInvocation/invoking': 'Capturing the page…',
        'openai/toolInvocation/invoked': 'Captured'
      }
    },
    async (input) =>
      run('forge_see', ctx.track, async () => {
        const requestedViewports = input.viewports?.length ? input.viewports : DEFAULT_VIEWPORTS;
        const viewports = [...new Set(requestedViewports)];
        // Reserve atomically before spending browser minutes. If every viewport
        // fails, release the reservation; successful/partial captures keep it.
        const quota = await reserveCaptureQuota(ctx.env, ctx.identity.userId, ctx.identity.githubLogin);
        let shot: Awaited<ReturnType<typeof capture>>;
        try {
          shot = await capture(ctx.env, input.url, viewports);
        } catch (error) {
          if (!quota.unlimited && quota.day) {
            await releaseCaptureQuota(ctx.env, ctx.identity.userId, quota.day).catch(() => {
              console.error('forge_capture_quota_release_failed', { userId: ctx.identity.userId });
            });
          }
          throw error;
        }
        ctx.track('capture_taken', {
          requested: viewports.length,
          captured: shot.images.length,
          failures: shot.failures.length
        });

        const limits = shot.failures.map((failure) => `${failure.viewport}: ${failure.reason}`);
        if (viewports.length < requestedViewports.length) {
          limits.push('Duplicate viewport requests were collapsed so each viewport is rendered at most once.');
        }
        if (shot.outlineTruncated) {
          limits.push(`The semantic outline was capped at ${shot.outline.length} lines.`);
        }

        // Always true, and never previously said: a capture is the first
        // screenful, not the page. A model told only "captured at phone and
        // desktop" will reason confidently about a long page it has seen 844
        // pixels of.
        limits.push('Each image is the top of the page at that viewport, not the full scrollable page.');

        // Keep images until the budget is spent, largest risk last: viewports
        // arrive in the order asked for, so the caller's first choice survives.
        const kept: typeof shot.images = [];
        let spent = 0;
        for (const image of shot.images) {
          if (spent + image.base64.length > MAX_IMAGE_BYTES) {
            limits.push(`The ${image.viewport} image was too large to return with the others and was dropped.`);
            continue;
          }
          spent += image.base64.length;
          kept.push(image);
        }

        // Stored before the images are trimmed for transport: the hosted copy
        // is the one place every viewport survives, including any the payload
        // budget drops below.
        const gallery = await storeGallery(
          ctx.env,
          shot,
          new Date().toISOString(),
          ctx.identity.userId
        );
        if (gallery === null && shot.images.length > 0) {
          limits.push('These images could not be saved to a link, so they exist only in this reply.');
        }

        const shown = kept.map((image) => image.viewport);
        const content: Content[] = [];
        if (shot.outline.length > 0) {
          content.push({
            type: 'text',
            text: `Page structure (accessibility reading order):\n${shot.outline.join('\n')}`
          });
        }

        // A label before each image: MCP image content carries no caption of
        // its own, so without this the model sees two pictures and cannot say
        // which one is the phone.
        for (const image of kept) {
          content.push(
            { type: 'text', text: image.viewport },
            { type: 'image', data: image.base64, mimeType: 'image/png' }
          );
        }

        return {
          summary: `Captured ${shot.title ? `"${shot.title}"` : shot.url} at ${shown.join(' and ')}.${quota.unlimited ? '' : ` ${quota.used} of ${quota.limit} captures used today.`}`,
          structured: withLimits(
            {
              page: { url: shot.url, title: shot.title, shown },
              ...(gallery === null ? {} : { gallery }),
              ...(quota.unlimited ? {} : { quota: `${quota.used} of ${quota.limit} used today` })
            },
            limits
          ),
          content
        };
      })
  );
}
