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
import { classifyExactMatchContextsWithJev, classifyHygieneCandidatesWithJev, classifyQualityGatesWithJev, judgeSeePacket, rankChangeFilesWithJev, rankImpactIdentifiersWithJev, rankPatchHunksWithJev, resolveRepoWithJev, routeForgeReadEvidenceWithJev, screenFileContentsWithJev, semanticFileExcerpt, semanticPathTriageDetailed } from './jev';
import {
  changeHotspots,
  exactFindNeedle,
  exactOccurrenceContexts,
  extractDeclaredQualityScripts,
  fileTotals,
  historyScope,
  humanBytes,
  hygieneContentPreview,
  hygienePathCandidates,
  hygieneReferenceTerm,
  isChurnQuery,
  isCodeownersPath,
  isDependencyManifestPath,
  isDependencyQuery,
  isImpactQuery,
  isHygieneQuery,
  isHygieneSourcePath,
  isLanguagesQuery,
  isMapQuery,
  isMigrationQuery,
  isPolicyQuery,
  isQualityQuery,
  isReviewQuery,
  isStatsQuery,
  lintCommittedFiles,
  migrationHistoryEvidence,
  patchIdentifierCandidates,
  qualityCandidatePaths,
  queryContentPreview,
  representativePatchHunks,
  splitPatchHunks,
  repositoryMap,
  repositoryStats,
  semanticCodeNeedle,
  statsScope
} from './repository-intelligence';
import { CHANGE_BRANCH, ensureDraftPullRequest, findChange, openChanges, openChangesTruncated } from './change';
import { buildChangeReviewPacket, changeReviewLines, changeReviewNotices } from './change-review';
import {
  readBranchPolicy,
  readCodeownersErrors,
  readCommitParents,
  readDependencyReview,
  readRecentChurn,
  readRecentHistory,
  readRepositoryLanguages,
  requiredCheckNames
} from './github-intelligence';
import { commitFiles } from './write';
import { assertNotNearExisting, createRepo, defaultBranch } from './repo';
import { buildPublicSearchQuery, buildSearchQuery, rankSearchResultsWithJev, searchCommittedText, searchGitHubCode, searchGitHubRepos, type SearchItem, type SearchResultSet } from './search';
import { capture } from './capture';
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
  /** Authenticated as the human. Only new-repo creation and explicit global public search use it. */
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
/** Internal-only budget: enough to lint a large changed source file without returning it to chat. */
const POST_COMMIT_FILE_BYTES = 256 * 1024;

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
async function resolveRepoTarget(ctx: ToolContext, value: string): Promise<RepoRef> {
  const trimmed = value.trim();

  if (trimmed.includes('/')) {
    try {
      return parseRepo(trimmed);
    } catch {
      // A human may have typed an informal owner/name; reachable repos below
      // are the only fuzzy candidates Forge is allowed to substitute.
    }
  }

  try {
    const repos = await listRepos(ctx.gh);
    const lower = trimmed.toLowerCase();
    const exact = repos.filter((entry) => {
      const name = entry.repo.split('/')[1] ?? entry.repo;
      return entry.repo.toLowerCase() === lower || name.toLowerCase() === lower;
    });
    if (exact.length === 1 && exact[0]) return parseRepo(exact[0].repo);

    const normalized = lower.replace(/[^a-z0-9]/g, '');
    if (normalized) {
      const matches = repos.filter((entry) => {
        const name = entry.repo.split('/')[1] ?? entry.repo;
        return (
          name.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized ||
          entry.repo.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized
        );
      });
      if (matches.length === 1 && matches[0]) return parseRepo(matches[0].repo);
    }

    if (ctx.env.TYPESAFE_API_KEY && repos.length > 0) {
      const match = await resolveRepoWithJev(ctx.env, trimmed, repos);
      if (match?.confidence && match.confidence >= 0.8) return parseRepo(match.repo);
    }
  } catch {
    // Resolution is convenience. Canonical parsing below remains deterministic.
  }

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
  return fileTotals(comparison.files);
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
  searchResults: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        repo: z.string(),
        path: z.string().optional(),
        snippet: z.string().optional(),
        url: z.string().optional(),
        stars: z.number().optional(),
        score: z.number().optional(),
        confidence: z.number().optional()
      })
    )
    .optional(),
  ...receiptFields
};

async function searchGlobal(ctx: ToolContext, query: string): Promise<ToolOutcome> {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      summary: 'Say what to search for on public GitHub.',
      structured: {
        searchResults: [],
        next: 'Pass a query, for example "MCP TypeScript repositories" or "OAuth callback code".'
      }
    };
  }

  const mode = /\b(repo|repos|repository|repositories|libraries)\b/i.test(trimmed) ? 'repos' : 'code';
  const searchQuery = buildPublicSearchQuery(trimmed, mode);

  if (mode === 'repos') {
    const found = await searchGitHubRepos(ctx.ghUser, searchQuery, 10);
    if (found.unavailable) {
      return {
        summary: found.unavailable,
        structured: withLimits(
          {
            repos: [],
            searchResults: [],
            next: 'Try again later. If authentication keeps failing, reconnect Forge in your client.'
          },
          [found.unavailable]
        )
      };
    }
    const { total, items } = found;
    const ranked = await rankSearchResultsWithJev(ctx.env, trimmed, items);
    return {
      summary: ranked.length
        ? `Found ${total} public GitHub repositor${total === 1 ? 'y' : 'ies'} for "${trimmed}".`
        : `No public GitHub repositories matched "${trimmed}".`,
      structured: {
        repos: ranked.map((item) => ({
          repo: item.repo,
          about: [item.snippet, item.stars ? `⭐ ${item.stars}` : '', item.url].filter(Boolean).join(' · ')
        })),
        searchResults: ranked,
        next: ranked.length
          ? 'Pass one result as owner/name to inspect it.'
          : 'Try fewer or broader search terms.'
      }
    };
  }

  const found = await searchGitHubCode(ctx.ghUser, searchQuery, 10);
  if (found.unavailable) {
    return {
      summary: found.unavailable,
      structured: withLimits(
        {
          files: [],
          searchResults: [],
          next: 'Try again later. If authentication keeps failing, reconnect Forge in your client.'
        },
        [found.unavailable]
      )
    };
  }
  const { total, items } = found;
  const ranked = await rankSearchResultsWithJev(ctx.env, trimmed, items);
  return {
    summary: ranked.length
      ? `Found ${total} public GitHub code match${total === 1 ? '' : 'es'} for "${trimmed}".`
      : `No public GitHub code matched "${trimmed}".`,
    structured: {
      files: ranked.map((item) => ({
        path: item.path ? `${item.repo}:${item.path}` : item.title,
        text: item.snippet ?? ''
      })),
      searchResults: ranked,
      next: ranked.length
        ? 'Pass a matching owner/name and path to inspect the committed file.'
        : 'Try fewer or broader search terms.'
    }
  };
}

async function readRepositories(ctx: ToolContext, query: string | undefined): Promise<ToolOutcome> {
  const trimmedQuery = query?.trim();

  if (trimmedQuery && /^(global|search|code):/i.test(trimmedQuery)) {
    const cleanQuery = trimmedQuery.replace(/^(global|search|code):\s*/i, '');
    return searchGlobal(ctx, cleanQuery);
  }

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
    if (trimmedQuery) {
      return searchGlobal(ctx, trimmedQuery);
    }
    return {
      summary: 'Forge cannot reach any repository for this account yet.',
      structured: withLimits(
        { repos: [], next: 'forge_edit creates a repository by writing the first file into it, or pass repo: "global" to search GitHub.' },
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
        next: 'Name one to see its files and open changes, or pass repo: "global" to search all of GitHub.'
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
  const gh = ctx.gh;
  const base = await defaultBranch(gh, repo);
  const trimmedQuery = query?.trim();
  const explicitMode = Boolean(
    trimmedQuery && (
      historyScope(trimmedQuery) !== undefined ||
      isChurnQuery(trimmedQuery) ||
      isLanguagesQuery(trimmedQuery) ||
      isPolicyQuery(trimmedQuery) ||
      isStatsQuery(trimmedQuery) ||
      isQualityQuery(trimmedQuery) ||
      isHygieneQuery(trimmedQuery) ||
      isMigrationQuery(trimmedQuery) ||
      isMapQuery(trimmedQuery) ||
      exactFindNeedle(trimmedQuery) ||
      semanticCodeNeedle(trimmedQuery)
    )
  );
  const routed = trimmedQuery && !explicitMode
    ? await routeForgeReadEvidenceWithJev(ctx.env, trimmedQuery, 'repository')
    : null;
  const routeNote = routed
    ? `Jev routed this natural-language question to ${routed.mode} evidence (${Math.round(routed.confidence * 100)}% choice confidence).`
    : null;
  const requestedHistory = routed?.mode === 'history'
    ? null
    : trimmedQuery
      ? historyScope(trimmedQuery)
      : undefined;

  if (requestedHistory !== undefined) {
    const [history, changes] = await Promise.all([
      readRecentHistory(gh, repo, base, requestedHistory ?? undefined, 12),
      openChanges(ctx.gh, repo)
    ]);
    const names = changeNames(changes);
    const where = requestedHistory ? ` for ${requestedHistory}` : '';
    const limits = [
      ...(routeNote ? [routeNote] : []),
      ...(history.unavailable ? [history.unavailable] : []),
      ...(history.truncated ? ['Showing the 12 most recent matching commits; older history exists.'] : []),
      ...changesLimits(changes)
    ];
    return {
      summary: `${formatRepo(repo)} ${base}: ${history.commits.length} recent commit${history.commits.length === 1 ? '' : 's'}${where}.${changesSentence(names)}`,
      structured: withLimits(
        {
          tree: history.commits.map((commit) => {
            const who = commit.author ?? commit.committer ?? 'unknown author';
            const when = commit.date?.slice(0, 10) ?? 'unknown date';
            const verified = commit.verified === null ? '' : commit.verified ? ' · verified' : ' · unverified';
            return `${commit.sha.slice(0, 7)} · ${when} · ${who}${verified} · ${commit.message || '(no message)'}`;
          }),
          changes: names,
          next: requestedHistory
            ? 'Read the current file or ask a semantic question about its implementation.'
            : 'Use "history <path>" to narrow history to one file or folder.'
        },
        limits
      )
    };
  }

  if (trimmedQuery && (isChurnQuery(trimmedQuery) || routed?.mode === 'churn')) {
    const [churn, changes] = await Promise.all([
      readRecentChurn(gh, repo, base, 8),
      openChanges(ctx.gh, repo)
    ]);
    const names = changeNames(changes);
    const limits = [
      ...(routeNote ? [routeNote] : []),
      ...(churn.unavailable ? [churn.unavailable] : []),
      ...(churn.truncated ? [`Churn is a bounded sample of ${churn.commitsSampled} recent commits; at least one history/file list extends beyond the sampled evidence.`] : []),
      ...changesLimits(changes)
    ];
    return {
      summary: `${formatRepo(repo)} ${base}: hottest tracked paths across ${churn.commitsSampled} recent commit${churn.commitsSampled === 1 ? '' : 's'}.${changesSentence(names)}`,
      structured: withLimits(
        {
          tree: churn.entries.slice(0, 20).map((entry) =>
            `HOT ${entry.path} · ${entry.touches}/${churn.commitsSampled} commits · +${entry.additions}/-${entry.deletions}`
          ),
          changes: names,
          next: churn.entries[0]
            ? `Use "history ${churn.entries[0].path}" to inspect the hottest path's recent commits.`
            : 'Use "history" to inspect recent commits.'
        },
        limits
      )
    };
  }

  if (trimmedQuery && (isLanguagesQuery(trimmedQuery) || routed?.mode === 'languages')) {
    const [languages, changes] = await Promise.all([
      readRepositoryLanguages(gh, repo),
      openChanges(ctx.gh, repo)
    ]);
    const names = changeNames(changes);
    const total = languages.languages.reduce((sum, language) => sum + language.bytes, 0);
    const limits = [
      ...(routeNote ? [routeNote] : []),
      ...(languages.unavailable ? [languages.unavailable] : []),
      ...changesLimits(changes)
    ];
    return {
      summary: `${formatRepo(repo)}: ${languages.languages.length} language${languages.languages.length === 1 ? '' : 's'} reported by GitHub, ${humanBytes(total)} classified.${changesSentence(names)}`,
      structured: withLimits(
        {
          tree: languages.languages.slice(0, 20).map((language) => {
            const percentage = total > 0 ? ((language.bytes / total) * 100).toFixed(1) : '0.0';
            return `LANG ${language.name} · ${humanBytes(language.bytes)} · ${percentage}%`;
          }),
          changes: names,
          next: 'Use "stats" for file/folder size and tree-shape statistics.'
        },
        limits
      )
    };
  }

  if (trimmedQuery && (isPolicyQuery(trimmedQuery) || routed?.mode === 'policy')) {
    const [policy, changes] = await Promise.all([
      readBranchPolicy(gh, repo, base),
      openChanges(ctx.gh, repo)
    ]);
    const names = changeNames(changes);
    const checks = requiredCheckNames(policy);
    const lines = policy.rules.map((rule) => {
      if (rule.type === 'required_status_checks' && checks.length > 0) {
        return `RULE required_status_checks · ${checks.join(', ')}`;
      }
      const source = [rule.sourceType, rule.source].filter(Boolean).join(' · ');
      return `RULE ${rule.type}${source ? ` · ${source}` : ''}`;
    });
    const limits = [
      ...(routeNote ? [routeNote] : []),
      ...(policy.unavailable ? [policy.unavailable] : []),
      ...(policy.truncated ? ['GitHub returned more than 100 active branch rules; this list is incomplete.'] : []),
      ...changesLimits(changes)
    ];
    return {
      summary: `${formatRepo(repo)} ${base}: ${policy.rules.length} active branch rule${policy.rules.length === 1 ? '' : 's'}${checks.length ? `; required checks: ${checks.join(', ')}` : ''}.${changesSentence(names)}`,
      structured: withLimits(
        {
          tree: lines,
          changes: names,
          next: checks.length > 0
            ? 'These are requirements GitHub enforces; Forge cannot see whether each check passed without additional Checks/Statuses permission.'
            : 'Ask for a change to see what would be merged.'
        },
        limits
      )
    };
  }

  const [tree, changes] = await Promise.all([
    readTree(gh, repo, base),
    openChanges(ctx.gh, repo)
  ]);

  const allFilePaths = tree.entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => entry.path);
  const names = changeNames(changes);

  if (trimmedQuery && (isMigrationQuery(trimmedQuery) || routed?.mode === 'migrations')) {
    const migration = migrationHistoryEvidence(tree.entries);
    let checkerFiles: Array<{ path: string; content: string }> = [];
    const checkerLimits: string[] = [];
    if (migration.checkerPaths.length > 0) {
      try {
        const checkerRead = await readFiles(
          gh,
          repo,
          base,
          migration.checkerPaths.slice(0, 4),
          MAX_FILE_BYTES
        );
        checkerFiles = checkerRead.files
          .filter((file) => !file.truncated)
          .map((file) => ({ path: file.path, content: file.content }));
        checkerLimits.push(
          ...checkerRead.skipped.map((skip) => `${skip.path} ${skip.reason}.`)
        );
      } catch {
        checkerLimits.push('Committed migration-checker files were discovered but could not be read in this call.');
      }
    }

    const exceptionLines: string[] = [];
    const exceptionCheckers = new Set<string>();
    for (const duplicate of migration.duplicates) {
      const names = duplicate.paths.map((path) => path.split('/').pop() ?? path);
      const checker = checkerFiles.find((file) =>
        names.every((name) => file.content.includes(name))
      );
      if (!checker) continue;
      exceptionCheckers.add(checker.path);
      exceptionLines.push(
        `EXCEPTION? ${duplicate.directory}/ · prefix ${duplicate.prefix} · ${checker.path} explicitly names ${names.join(', ')}`
      );
    }

    const duplicateNames = migration.duplicates
      .flatMap((duplicate) => duplicate.paths)
      .map((path) => path.split('/').pop() ?? path)
      .join(' ');
    const checkerEvidence = checkerFiles
      .filter((file) => exceptionCheckers.has(file.path))
      .map((file) => ({
        path: file.path,
        text: queryContentPreview(file.content, duplicateNames || 'migration exception', 3200)
      }));

    const limits = [
      ...(routeNote ? [routeNote] : []),
      ...(tree.truncated ? ['GitHub truncated the repository tree, so migration evidence may be incomplete.'] : []),
      ...(migration.issues > 0
        ? ['DUPLICATE? and MISSING? are structural irregularities, not proof a deployment is unsafe. Recognized EXCEPTION? duplicates are removed from the unresolved count.']
        : []),
      ...(exceptionLines.length > 0
        ? ['EXCEPTION? means a committed migration checker literally names every file in that duplicate-prefix set. It is evidence of an intentional repository policy, not proof that deployed database state is correct.']
        : []),
      ...checkerLimits,
      'Forge does not execute migrations or query deployed database state; this view inspects committed filenames and verifier evidence only.',
      ...changesLimits(changes)
    ];
    const unresolvedIssues = Math.max(0, migration.issues - exceptionLines.length);
    const exceptionSummary = exceptionLines.length > 0
      ? `; ${exceptionLines.length} recognized duplicate exception${exceptionLines.length === 1 ? '' : 's'}`
      : '';
    return {
      summary: `${formatRepo(repo)} at ${base}: ${migration.files} numbered SQL migration file${migration.files === 1 ? '' : 's'}; ${migration.issues} structural irregularit${migration.issues === 1 ? 'y' : 'ies'}${exceptionSummary}; ${unresolvedIssues} unresolved.${changesSentence(names)}`,
      structured: withLimits(
        {
          tree: [...migration.lines, ...exceptionLines],
          ...(checkerEvidence.length > 0 ? { files: checkerEvidence } : {}),
          changes: names,
          next: unresolvedIssues > 0
            ? 'Inspect the unresolved duplicate/missing prefixes and compare committed migration policy with deployed database state before release.'
            : migration.issues > 0
              ? 'All structural irregularities found here are explicitly recognized by committed checker evidence. Confirm deployed database state separately before release.'
              : 'Use "quality" to inspect the committed scripts/CI that validate migrations.'
        },
        limits
      )
    };
  }

  if (trimmedQuery && (isHygieneQuery(trimmedQuery) || routed?.mode === 'hygiene')) {
    const sourcePaths = allFilePaths.filter(isHygieneSourcePath);
    const pathCandidates = hygienePathCandidates(tree.entries, 24);
    const markerTerms = ['legacy', 'deprecated', 'retired', 'fallback', 'compatibility', 'unused', '"not implemented"'];
    const markerSearches = await Promise.all(
      markerTerms.map(async (marker) => ({
        marker,
        result: await searchGitHubCode(gh, `repo:${formatRepo(repo)} ${marker}`, 8)
      }))
    );

    const markerSignals = new Map<string, string[]>();
    const markerPaths: string[] = [];
    for (const search of markerSearches) {
      for (const item of search.result.items) {
        if (!item.path || !isHygieneSourcePath(item.path)) continue;
        markerPaths.push(item.path);
        const current = markerSignals.get(item.path) ?? [];
        const signal = `content marker ${search.marker.replaceAll('"', '')}`;
        if (!current.includes(signal)) current.push(signal);
        markerSignals.set(item.path, current);
      }
    }

    const discoveredBeforeSemantic = [...new Set([
      ...pathCandidates.map((candidate) => candidate.path),
      ...markerPaths
    ])];
    const semantic = discoveredBeforeSemantic.length < 12
      ? await semanticPathTriageDetailed(
          ctx.env,
          sourcePaths,
          'legacy fallback compatibility deprecated obsolete superseded old implementation dead unused unreachable temporary broken incomplete cleanup candidate'
        )
      : null;
    const semanticPaths = semantic?.paths ?? [];
    const candidatePaths = [...new Set([
      ...discoveredBeforeSemantic,
      ...semanticPaths
    ])].slice(0, 20);
    const read = candidatePaths.length > 0
      ? await readFiles(gh, repo, base, candidatePaths, MAX_FILE_BYTES)
      : { files: [], skipped: [] };
    const pathSignals = new Map(pathCandidates.map((candidate) => [candidate.path, candidate.signals]));
    const semanticSet = new Set(semanticPaths);
    const prepared = read.files
      .filter((file) => !file.truncated)
      .slice(0, 12)
      .map((file) => ({
        path: file.path,
        content: file.content,
        preview: hygieneContentPreview(file.content),
        signals: [
          ...(pathSignals.get(file.path) ?? []),
          ...(markerSignals.get(file.path) ?? []),
          ...(semanticSet.has(file.path) ? ['Jev semantic path finalist'] : [])
        ]
      }));

    const classifications = await classifyHygieneCandidatesWithJev(
      ctx.env,
      prepared.map((file) => ({ path: file.path, preview: file.preview, signals: file.signals }))
    );
    const preparedByPath = new Map(prepared.map((file) => [file.path, file]));
    const suspiciousKinds = new Set([
      'legacy/superseded',
      'fallback/recovery',
      'likely-dead/unreachable',
      'possibly-broken/incomplete'
    ]);
    const suspicious = classifications.filter(
      (candidate) => suspiciousKinds.has(candidate.kind) && candidate.investigate >= 0.55
    );

    const evidenceTargets = suspicious.slice(0, 4);
    const evidence = await Promise.all(
      evidenceTargets.map(async (candidate) => {
        const file = preparedByPath.get(candidate.path);
        const term = file ? hygieneReferenceTerm(file.path, file.content) : null;
        const [references, history] = await Promise.all([
          term
            ? searchGitHubCode(gh, `repo:${formatRepo(repo)} "${term.replaceAll('"', ' ')}"`, 10)
            : Promise.resolve({ total: 0, items: [], unavailable: undefined }),
          readRecentHistory(gh, repo, base, candidate.path, 1)
        ]);
        const outside = references.items.filter((item) => item.path && item.path !== candidate.path);
        return {
          path: candidate.path,
          term,
          totalReferences: term && !references.unavailable ? references.total : null,
          referenceUnavailable: references.unavailable ?? null,
          outsideShown: outside.length,
          recent: history.commits[0]
        };
      })
    );
    const evidenceByPath = new Map(evidence.map((item) => [item.path, item]));
    const labelFor = (kind: string): string => {
      if (kind === 'legacy/superseded') return 'LEGACY?';
      if (kind === 'fallback/recovery') return 'FALLBACK?';
      if (kind === 'likely-dead/unreachable') return 'DEAD?';
      if (kind === 'possibly-broken/incomplete') return 'BROKEN?';
      if (kind === 'compatibility-intentional') return 'COMPAT';
      if (kind === 'active/current') return 'ACTIVE';
      return 'UNCLEAR';
    };
    const lines = classifications.map((candidate) => {
      const evidenceItem = evidenceByPath.get(candidate.path);
      const reference = evidenceItem?.term
        ? evidenceItem.referenceUnavailable
          ? ` · ref "${evidenceItem.term}" unavailable`
          : ` · ref "${evidenceItem.term}" ${evidenceItem.totalReferences} GitHub result${evidenceItem.totalReferences === 1 ? '' : 's'}, ${evidenceItem.outsideShown} outside shown`
        : '';
      const history = evidenceItem?.recent
        ? ` · last ${evidenceItem.recent.date?.slice(0, 10) ?? 'unknown date'} ${evidenceItem.recent.sha.slice(0, 7)} ${evidenceItem.recent.message || '(no message)'}`
        : '';
      return `${labelFor(candidate.kind)} ${candidate.path} · ${Math.round(candidate.confidence * 100)}% class · investigate ${Math.round(candidate.investigate * 100)}% · deletion-behavior ${Math.round(candidate.deletionChangesBehavior * 100)}%${reference}${history}`;
    });
    if (lines.length === 0) {
      lines.push(...prepared.map((file) => `CANDIDATE? ${file.path} · ${file.signals.join(', ') || 'bounded semantic candidate'}`));
    }

    const markerTotal = markerSearches.reduce((sum, search) => sum + search.result.total, 0);
    const markerUnavailable = [...new Set(
      markerSearches
        .map((search) => search.result.unavailable)
        .filter((value): value is string => Boolean(value))
    )];
    const limits = [
      ...(routeNote ? [routeNote] : []),
      ...(tree.truncated ? ['GitHub truncated the repository tree, so hygiene discovery is incomplete.'] : []),
      ...(semantic?.truncated ? [`Jev hygiene path triage considered ${semantic.considered} representative paths from ${semantic.total} source files.`] : []),
      ...(candidatePaths.length >= 20 ? ['Hygiene content inspection is capped at 20 candidate paths and Jev classification at 12 complete files.'] : []),
      ...(markerTotal > markerPaths.length ? ['GitHub marker searches are bounded; additional lexical matches may exist beyond the returned candidate paths.'] : []),
      ...markerUnavailable,
      ...(classifications.length === 0 && prepared.length > 0 ? ['Jev returned no hygiene classification; CANDIDATE? lines are deterministic discovery evidence only.'] : []),
      ...read.skipped.map((skip) => `${skip.path} ${skip.reason}.`),
      'LEGACY?, FALLBACK?, DEAD? and BROKEN? are investigation labels from bounded semantic evidence, not proof that code is unreachable, defective, or safe to delete.',
      'Reference evidence is bounded GitHub text search, not a compiler-backed call/reference graph.',
      ...changesLimits(changes)
    ];
    const resultSummary = classifications.length > 0
      ? `Jev surfaced ${suspicious.length} legacy/fallback/dead-looking/broken-looking candidate${suspicious.length === 1 ? '' : 's'}`
      : `showing ${prepared.length} deterministic candidate${prepared.length === 1 ? '' : 's'} because Jev returned no classification`;
    return {
      summary: `${formatRepo(repo)} at ${base}: inspected ${prepared.length} hygiene candidate file${prepared.length === 1 ? '' : 's'}; ${resultSummary}.${changesSentence(names)}`,
      structured: withLimits(
        {
          tree: lines,
          files: evidenceTargets.map((candidate) => {
            const file = preparedByPath.get(candidate.path)!;
            return {
              path: candidate.path,
              text: `${file.signals.join(', ') || 'semantic candidate'}\n\n${file.preview}`
            };
          }),
          changes: names,
          next: suspicious.length > 0
            ? 'Read the strongest candidate paths in full. Confirm deadness with compiler/static-analysis/CI evidence before deleting anything; intentional compatibility and fallback paths should be preserved when still required.'
            : 'No strong Jev hygiene candidate surfaced in this bounded pass. Static dead-code tooling can still find reachability issues Jev cannot prove.'
        },
        limits
      )
    };
  }

  if (trimmedQuery && (isStatsQuery(trimmedQuery) || routed?.mode === 'stats')) {
    const scope = statsScope(trimmedQuery);
    const scopedEntries = scope
      ? tree.entries.filter((entry) => entry.path === scope || entry.path.startsWith(`${scope}/`))
      : tree.entries;
    const stats = repositoryStats(scopedEntries);
    const limits = [
      ...(routeNote ? [routeNote] : []),
      ...(scope && stats.files === 0 ? [`No tracked files were found under ${scope}.`] : []),
      ...(tree.truncated ? ['GitHub truncated this listing, so these statistics are incomplete.'] : []),
      ...changesLimits(changes)
    ];
    const where = scope ? ` under ${scope}` : '';
    return {
      summary: `${formatRepo(repo)} at ${base}${where}: ${stats.files} files, ${humanBytes(stats.bytes)} of tracked file content.${changesSentence(names)}`,
      structured: withLimits(
        {
          tree: stats.lines,
          changes: names,
          next: 'Ask for another folder with "stats <path>", use "map" for repository shape, or "find:<text>" for exact committed-code search.'
        },
        limits
      )
    };
  }

  if (trimmedQuery && (isQualityQuery(trimmedQuery) || routed?.mode === 'quality')) {
    const candidates = qualityCandidatePaths(tree.entries, 16);
    const read = candidates.length > 0
      ? await readFiles(gh, repo, base, candidates, MAX_FILE_BYTES)
      : { files: [], skipped: [] };
    const completeFiles = read.files
      .filter((file) => !file.truncated)
      .map((file) => ({ path: file.path, content: file.content }));
    const scripts = extractDeclaredQualityScripts(completeFiles);
    const gates = await classifyQualityGatesWithJev(ctx.env, completeFiles);
    const lines = [
      ...scripts.map((script) => `SCRIPT ${script.path} · ${script.name} = ${script.command}`),
      ...gates.map((gate) => `LIKELY GATE ${gate.kind} · ${gate.path} · ${Math.round(gate.confidence * 100)}%`)
    ];
    if (lines.length === 0) lines.push(...candidates.map((path) => `CONFIG ${path}`));
    const limits = [
      ...(routeNote ? [routeNote] : []),
      ...(tree.truncated ? ['GitHub truncated the repository tree, so some quality configuration may be absent.'] : []),
      ...(candidates.length >= 16 ? ['Quality-gate inspection is capped at 16 likely configuration files.'] : []),
      ...read.skipped.map((skip) => `${skip.path} ${skip.reason}.`),
      ...(gates.length > 0 ? ['LIKELY GATE lines are Jev interpretations of committed configuration; they do not mean a check ran or passed.'] : []),
      ...changesLimits(changes)
    ];
    return {
      summary: `${formatRepo(repo)} at ${base}: ${scripts.length} declared quality-related script${scripts.length === 1 ? '' : 's'} and ${gates.length} likely gate categor${gates.length === 1 ? 'y' : 'ies'} from committed configuration.${changesSentence(names)}`,
      structured: withLimits(
        {
          tree: lines,
          changes: names,
          next: 'Use "policy" to see which status-check names GitHub actually requires at merge time.'
        },
        limits
      )
    };
  }

  if (trimmedQuery && (isMapQuery(trimmedQuery) || routed?.mode === 'map')) {
    const lines = repositoryMap(tree.entries);
    const limits = [
      ...(routeNote ? [routeNote] : []),
      ...(tree.truncated ? ['GitHub truncated this listing, so this repository map is incomplete.'] : []),
      ...changesLimits(changes)
    ];
    return {
      summary: `${formatRepo(repo)} at ${base}: repository shape from ${allFilePaths.length} tracked files.${changesSentence(names)}`,
      structured: withLimits(
        {
          tree: lines,
          changes: names,
          next: 'Ask about a mapped area semantically, or use "code:<concept>" to search committed code rather than filenames.'
        },
        limits
      )
    };
  }

  const findNeedle = trimmedQuery ? exactFindNeedle(trimmedQuery) : null;
  if (findNeedle) {
    const safeNeedle = findNeedle.replaceAll('"', ' ');
    const searched = await searchGitHubCode(gh, `repo:${formatRepo(repo)} "${safeNeedle}"`, 25);
    // The index can answer with nothing for code that is there. When it comes
    // back empty or incomplete, read the committed files themselves and answer
    // from them — the repository is the truth, the index is only a shortcut.
    const committed = await fallbackToCommittedText(ctx, repo, base, [safeNeedle], searched, true);
    const found = committed.found;
    if (found.unavailable) {
      return {
        summary: `${found.unavailable} Exact search for "${findNeedle}" in ${formatRepo(repo)} was not completed.`,
        structured: withLimits(
          {
            tree: [],
            files: [],
            changes: names,
            next: 'Try the exact search again later, or read a known path directly.'
          },
          [found.unavailable, ...changesLimits(changes)]
        )
      };
    }
    const ranked = committed.used
      ? found.items
      : await rankSearchResultsWithJev(ctx.env, findNeedle, found.items);
    const shown = ranked.slice(0, 25);
    const uniquePaths = [...new Set(shown.map((item) => item.path).filter((path): path is string => Boolean(path)))];
    const limits = [
      ...(committed.used ? [committed.note] : []),
      ...(!committed.used && found.incomplete ? ['GitHub code search returned a partial answer, so matches may be missing.'] : []),
      ...(found.total > shown.length ? [`Showing ${shown.length} of ${found.total} code results.`] : []),
      ...changesLimits(changes)
    ];

    const counts = new Map<string, number>();
    const contextLines = new Map<string, string[]>();
    if (uniquePaths.length > 0) {
      try {
        const measured = await readFiles(gh, repo, base, uniquePaths.slice(0, 10), MAX_FILE_BYTES);
        const complete = measured.files.filter((file) => !file.truncated);
        for (const file of complete) counts.set(file.path, file.content.split(findNeedle).length - 1);

        const occurrences = exactOccurrenceContexts(
          complete.map((file) => ({ path: file.path, content: file.content })),
          findNeedle,
          20
        );
        const classifications = await classifyExactMatchContextsWithJev(ctx.env, findNeedle, occurrences.contexts);
        const byId = new Map(classifications.map((classification) => [classification.id, classification]));
        for (const context of occurrences.contexts) {
          const classification = byId.get(context.id);
          const confidence = classification?.confidence ?? 0;
          const kind = classification?.kind ?? 'unknown';
          const line = `L${context.line} ${kind}${confidence > 0 ? ` ${Math.round(confidence * 100)}%` : ''}`;
          const existing = contextLines.get(context.path) ?? [];
          existing.push(line);
          contextLines.set(context.path, existing);
        }
        if (occurrences.contexts.length > 0 && classifications.length > 0) {
          limits.push('Jev match roles classify bounded local text contexts; they are not compiler-backed symbol references.');
        }
        if (occurrences.truncated) {
          limits.push('Semantic match-role classification is capped at the first 20 exact occurrences across measured files.');
        }
        if (uniquePaths.length > 10 || measured.skipped.length > 0) {
          limits.push('Exact occurrence counts and match roles are measured only for complete matching files that fit the read budget; search paths remain the discovery result.');
        }
      } catch {
        // Search evidence is still useful when exact counting cannot be measured.
      }
    }

    return {
      summary: `Found ${found.total} committed code result${found.total === 1 ? '' : 's'} for "${findNeedle}" in ${formatRepo(repo)}; showing ${shown.length}.${changesSentence(names)}`,
      structured: withLimits(
        {
          tree: uniquePaths,
          files: shown.map((item) => {
            const count = item.path ? counts.get(item.path) : undefined;
            return {
              path: item.path ?? item.title,
              text: `${count === undefined ? '' : `${count} exact occurrence${count === 1 ? '' : 's'} · `}${contextLines.get(item.path ?? '')?.join(', ') ? `${contextLines.get(item.path ?? '')!.join(', ')} · ` : ''}${item.snippet ?? ''}`
            };
          }),
          changes: names,
          next:
            uniquePaths.length > 0
              ? 'Review the occurrence roles, then use forge_edit fragment replacements and all:true only when every exact textual occurrence in that file should change. A write is capped at 10 files.'
              : 'Try a shorter exact term, or use "code:<concept>" for semantic committed-code search.'
        },
        limits
      )
    };
  }

  const codeNeedle = trimmedQuery ? semanticCodeNeedle(trimmedQuery) : null;
  if (codeNeedle) {
    const built = buildSearchQuery(codeNeedle, 'code');
    const withoutRepo = built.replace(/(?:^|\s)repo:[^\s]+/gi, ' ').trim();
    const searched = await searchGitHubCode(gh, `repo:${formatRepo(repo)} ${withoutRepo}`, 15);
    // Same fallback as exact search: a degraded index must not read as absence,
    // and the committed files are the answer the index was standing in for.
    const committed = await fallbackToCommittedText(ctx, repo, base, conceptTokens(codeNeedle), searched);
    const found = committed.found;
    if (found.unavailable) {
      return {
        summary: `${found.unavailable} Semantic code search for "${codeNeedle}" in ${formatRepo(repo)} was not completed.`,
        structured: withLimits(
          {
            tree: [],
            files: [],
            changes: names,
            next: 'Try again later, or ask a filename/path-oriented question that can use the committed tree.'
          },
          [found.unavailable, ...changesLimits(changes)]
        )
      };
    }
    const ranked = committed.used
      ? found.items
      : await rankSearchResultsWithJev(ctx.env, codeNeedle, found.items);
    const shown = ranked.slice(0, 15);
    const uniquePaths = [...new Set(shown.map((item) => item.path).filter((path): path is string => Boolean(path)))];
    const limits = [
      ...(committed.used ? [committed.note] : []),
      ...(!committed.used && found.incomplete ? ['GitHub code search returned a partial answer, so matches may be missing.'] : []),
      ...(found.total > shown.length ? [`Showing ${shown.length} of ${found.total} committed-code results.`] : []),
      ...changesLimits(changes)
    ];
    return {
      summary: `Found ${found.total} committed-code result${found.total === 1 ? '' : 's'} for "${codeNeedle}" in ${formatRepo(repo)}; ${committed.used ? 'from the committed files' : 'semantically ranked'}.${changesSentence(names)}`,
      structured: withLimits(
        {
          tree: uniquePaths,
          files: shown.map((item) => ({ path: item.path ?? item.title, text: item.snippet ?? '' })),
          changes: names,
          next: uniquePaths.length > 0 ? 'Read the strongest matching paths for full context.' : 'Try fewer concept words or use a filename-oriented semantic query.'
        },
        limits
      )
    };
  }

  let paths = allFilePaths;
  let isSemanticSearch = false;
  let semanticCoverageNote: string | undefined;
  let semanticUnavailable: string | undefined;
  let committedFallbackNote: string | undefined;
  let isContentFallback = false;
  let contentFallbackExcerpts: Array<{ path: string; text: string }> = [];

  if (trimmedQuery) {
    const trimmed = trimmedQuery;
    const semanticResult = await semanticPathTriageDetailed(ctx.env, allFilePaths, trimmed);
    if (semanticResult?.truncated) {
      semanticCoverageNote = `Jev semantic path triage considered ${semanticResult.considered} representative paths from ${semanticResult.total} tracked files before the global rerank.`;
    }
    if (semanticResult && semanticResult.paths.length > 0) {
      paths = semanticResult.paths;
      isSemanticSearch = true;
    } else {
      const needle = trimmed.toLowerCase();
      paths = allFilePaths.filter((path) => path.toLowerCase().includes(needle));

      // A natural concept can be absent from every filename while still being
      // plainly present in committed code. Only pay for a search when the cheap
      // path answers produced nothing. GitHub is the index; the committed files
      // are the fallback when the index does not answer, and a search that did
      // not complete is never allowed to read as "no files match".
      if (paths.length === 0 && trimmed.length >= 3) {
        try {
          const built = buildSearchQuery(trimmed, 'code');
          const withoutRepo = built.replace(/(?:^|\s)repo:[^\s]+/gi, ' ').trim();
          const searched = await searchGitHubCode(gh, `repo:${formatRepo(repo)} ${withoutRepo}`, 10);
          const committed = await fallbackToCommittedText(ctx, repo, base, conceptTokens(trimmed), searched);

          let ranked: SearchItem[] = [];
          if (committed.used) {
            committedFallbackNote = committed.note;
            ranked = committed.found.items;
            if (ranked.length === 0 && committed.found.incomplete) {
              semanticUnavailable = 'The committed-content search reached its bound without finding a match, so no absence conclusion was made.';
            }
          } else if (searched.items.length > 0) {
            ranked = await rankSearchResultsWithJev(ctx.env, trimmed, searched.items);
          } else if (searched.unavailable) {
            semanticUnavailable = searched.unavailable;
          }

          const contentPaths = [...new Set(ranked.map((item) => item.path).filter((path): path is string => Boolean(path)))];
          if (contentPaths.length > 0) {
            paths = contentPaths;
            isContentFallback = true;
            contentFallbackExcerpts = ranked
              .filter((item): item is typeof item & { path: string } => Boolean(item.path))
              .slice(0, 5)
              .map((item) => ({ path: item.path, text: item.snippet ?? '' }));
          }
        } catch {
          // Exact path filtering remains the deterministic fallback.
        }
      }
    }
  }

  const fileExcerpts: Array<{ path: string; text: string }> = [...contentFallbackExcerpts];
  let contentScreened = false;

  if (isSemanticSearch && paths.length > 0 && ctx.env.TYPESAFE_API_KEY) {
    try {
      const candidatePaths = paths.slice(0, 8);
      const readResult = await readFiles(gh, repo, base, candidatePaths, MAX_FILE_BYTES);
      const complete = readResult.files.filter((file) => !file.truncated);
      const relevance = await screenFileContentsWithJev(
        ctx.env,
        trimmedQuery ?? '',
        complete.map((file) => ({
          path: file.path,
          preview: queryContentPreview(file.content, trimmedQuery ?? '')
        }))
      );
      const scored = relevance
        .flatMap((item) =>
          item.probability === null ? [] : [{ path: item.path, probability: item.probability }]
        )
        .sort((left, right) => right.probability - left.probability);
      const strong = scored.filter((item) => item.probability >= 0.35);

      if (scored.length > 0) contentScreened = true;
      if (strong.length > 0) {
        const strongPaths = strong.map((item) => item.path);
        const strongSet = new Set(strongPaths);
        paths = [...strongPaths, ...paths.filter((path) => !strongSet.has(path))];

        const byPath = new Map(complete.map((file) => [file.path, file]));
        for (const candidate of strong.slice(0, 2)) {
          const file = byPath.get(candidate.path);
          if (!file) continue;
          const excerpt = await semanticFileExcerpt(ctx.env, file.path, file.content, trimmedQuery ?? '');
          if (excerpt && excerpt.confidence >= 0.35) {
            fileExcerpts.push({
              path: `${file.path} (lines ${excerpt.startLine}-${excerpt.endLine})`,
              text: excerpt.content
            });
          }
        }
      }
    } catch {
      // Path ranking still answers the query when content screening is unavailable.
    }
  }

  // A query that could not be searched is not a query with no matches. Saying
  // "0 files" here would be the same false absence the index itself produces.
  if (paths.length === 0 && semanticUnavailable) {
    return {
      summary: `${semanticUnavailable} No files could be matched for "${query?.trim()}" in ${formatRepo(repo)}.${changesSentence(names)}`,
      structured: withLimits(
        { tree: [], files: [], changes: names, next: 'Read a known path directly, or try a filename or "find:<exact text>" query.' },
        [semanticUnavailable, ...changesLimits(changes)]
      )
    };
  }

  const shown = paths.slice(0, MAX_TREE_ENTRIES);

  const limits: string[] = [];
  if (semanticCoverageNote) limits.push(semanticCoverageNote);
  if (committedFallbackNote) limits.push(committedFallbackNote);
  if (contentScreened) {
    limits.push('Jev independently screened up to eight committed candidate files; only selected excerpts are returned, not the screened file contents.');
  }
  if (paths.length > shown.length) {
    limits.push(`Showing ${shown.length} of ${paths.length} files. Pass query to narrow the list.`);
  }
  if (tree.truncated) {
    limits.push('GitHub truncated this listing, so some files are missing from it.');
  }

  const queryNote = isSemanticSearch
    ? ` matching "${query?.trim()}" (semantically ranked by Jev across ${allFilePaths.length} paths${contentScreened ? ' and bounded committed content' : ''})`
    : isContentFallback
      ? ` matching "${query?.trim()}" (committed-code fallback after no filename match)`
      : query?.trim()
        ? ` matching "${query.trim()}"`
        : '';
  const excerptSentence =
    fileExcerpts.length === 1
      ? `. Relevant excerpt from ${fileExcerpts[0]?.path} included below`
      : fileExcerpts.length > 1
        ? `. Relevant excerpts from ${fileExcerpts.map((e) => e.path.split(' ')[0]).join(' and ')} included below`
        : '';

  return {
    summary: `${formatRepo(repo)} at ${base}: ${shown.length} file${shown.length === 1 ? '' : 's'}${queryNote}${excerptSentence}.${changesSentence(names)}`,
    structured: withLimits(
      {
        tree: shown,
        ...(fileExcerpts.length > 0 ? { files: fileExcerpts } : {}),
        changes: names,
        next:
          names.length > 0
            ? 'Say a change name to see what it did.'
            : 'Ask for paths to read any of these files (or include query for targeted excerpts).'
      },
      limits
    )
  };
}

/**
 * Answers a repository-scoped search from the repository's own committed files
 * when GitHub's code-search index comes back empty or incomplete.
 *
 * The index is a shortcut, not the truth: a 200 with `incomplete_results: true`
 * and no matches means "the index did not answer", not "this code is absent".
 * The archive answers the same question exactly, within a stated bound, so a
 * degraded index stops being an absence and stops being a dead end.
 */
async function fallbackToCommittedText(
  ctx: ToolContext,
  repo: RepoRef,
  base: string,
  needles: string[],
  searched: SearchResultSet,
  caseSensitive = false
): Promise<{ found: SearchResultSet; used: boolean; note: string }> {
  const notUsed = { found: searched, used: false, note: '' };
  if (!searched.unavailable && !searched.incomplete && searched.total > 0) return notUsed;

  const wanted = needles.map((needle) => needle.trim()).filter((needle) => needle.length > 0);
  if (wanted.length === 0) return notUsed;

  const local = await searchCommittedText(ctx.gh, repo, base, wanted, { caseSensitive });
  if (local.unavailable) {
    // GitHub's own reason wins when it had one; otherwise the archive is why
    // the search could not complete, and neither may read as absence.
    return searched.unavailable
      ? notUsed
      : { found: { total: 0, items: [], unavailable: local.unavailable }, used: false, note: '' };
  }

  // Files matching more of a multi-word concept first, then by raw occurrence
  // count, so a concept search is not flooded by a file that merely repeats one
  // common word.
  const items = [...local.hits]
    .sort((left, right) => right.matched - left.matched || right.count - left.count)
    .map((hit) => ({
      id: `${formatRepo(repo)}/${hit.path}`,
      title: `${formatRepo(repo)}:${hit.path}`,
      repo: formatRepo(repo),
      path: hit.path,
      snippet:
        `${wanted.length > 1 ? `${hit.matched} of ${wanted.length} terms · ` : ''}` +
        `${hit.count} exact occurrence${hit.count === 1 ? '' : 's'}${hit.lines.length > 0 ? ` · lines ${hit.lines.join(', ')}` : ''}`
    }));

  return {
    found: { total: items.length, items, ...(local.truncated ? { incomplete: true } : {}) },
    used: true,
    note: local.truncated
      ? 'GitHub code search did not answer; these matches were read from the committed files under a size bound, so more may exist.'
      : "GitHub code search did not answer; these matches were read directly from the repository's committed files."
  };
}

/** Words worth looking up verbatim when a concept falls back to committed content. */
function conceptTokens(concept: string): string[] {
  return [
    ...new Set(
      concept
        .split(/[^A-Za-z0-9_]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
    )
  ].slice(0, 5);
}

async function readFilesLevel(
  ctx: ToolContext,
  repo: RepoRef,
  paths: string[],
  query?: string
): Promise<ToolOutcome> {
  const gh = ctx.gh;
  const base = await defaultBranch(gh, repo);
  const [read, changes] = await Promise.all([
    readFiles(gh, repo, base, paths, MAX_FILE_BYTES),
    openChanges(ctx.gh, repo)
  ]);

  const names = changeNames(changes);
  const skippedNotes = read.skipped.map((skip) => `${skip.path} ${skip.reason}.`);

  let filesToReturn = read.files;
  if (query?.trim()) {
    const trimmed = query.trim();
    const excerptResults = await Promise.all(
      read.files.map(async (file) => {
        const excerpt = await semanticFileExcerpt(ctx.env, file.path, file.content, trimmed);
        if (excerpt) {
          skippedNotes.push(
            `Targeted excerpt for '${trimmed}' in ${file.path} (lines ${excerpt.startLine}-${excerpt.endLine}, confidence ${(excerpt.confidence * 100).toFixed(0)}%). Omit query to read the full file.`
          );
          return {
            path: `${file.path} (lines ${excerpt.startLine}-${excerpt.endLine})`,
            content: excerpt.content,
            bytes: excerpt.content.length,
            truncated: true
          };
        }
        return file;
      })
    );
    filesToReturn = excerptResults;
  }

  return {
    summary: `${filesToReturn.length} of ${paths.length} file${paths.length === 1 ? '' : 's'} from ${formatRepo(repo)} at ${base}.${changesSentence(names)}`,
    structured: withLimits(
      {
        files: filesToReturn.map((file) => ({ path: file.path, text: file.content })),
        changes: names,
        next: query?.trim()
          ? 'Omit query to read full files, or forge_edit to write changes.'
          : 'forge_edit writes these back on a change of its own.'
      },
      skippedNotes
    )
  };
}

async function readChangeLevel(
  ctx: ToolContext,
  repo: RepoRef,
  wanted: string,
  paths: string[] | undefined,
  query?: string
): Promise<ToolOutcome> {
  const gh = ctx.gh;
  const base = await defaultBranch(gh, repo);
  const change = await findChange(ctx.gh, repo, wanted);
  const comparison = await compare(gh, repo, base, change.branch, paths);

  const limits: string[] = [];
  const asked = new Set(paths ?? []);
  for (const path of asked) {
    if (!comparison.files.some((file) => file.path === path)) {
      limits.push(`${path} is not touched by "${change.name}".`);
    }
  }

  // Files the caller asked about come first, so a cap can never be what
  // removes the one patch they were looking for.
  let ordered = [
    ...comparison.files.filter((file) => asked.has(file.path)),
    ...comparison.files.filter((file) => !asked.has(file.path))
  ];

  let semanticallyRanked = false;
  let statsNote = '';
  const semanticPatchByPath = new Map<string, string>();
  const trimmedQuery = query?.trim();
  const explicitMode = Boolean(
    trimmedQuery && (
      isReviewQuery(trimmedQuery) ||
      isImpactQuery(trimmedQuery) ||
      isDependencyQuery(trimmedQuery) ||
      isPolicyQuery(trimmedQuery) ||
      isStatsQuery(trimmedQuery)
    )
  );
  const routed = trimmedQuery && !explicitMode
    ? await routeForgeReadEvidenceWithJev(ctx.env, trimmedQuery, 'change')
    : null;
  if (routed) {
    limits.push(`Jev routed this natural-language change question to ${routed.mode} evidence (${Math.round(routed.confidence * 100)}% choice confidence).`);
  }

  if (trimmedQuery && (isReviewQuery(trimmedQuery) || routed?.mode === 'review')) {
    const packet = await buildChangeReviewPacket(ctx.env, gh, repo, base, change, comparison);
    const changes = await openChanges(ctx.gh, repo);
    const names = changeNames(changes);
    const size = totals(comparison);
    const reviewLines = changeReviewLines(packet);
    const reviewLimits = [
      ...limits,
      ...changeReviewNotices(packet, comparison, base),
      ...(comparison.truncated ? ['GitHub truncated this comparison, so changed-file evidence is incomplete.'] : [])
    ];
    return {
      summary: `Review of "${change.name}" against ${base}: ${size.files} file${size.files === 1 ? '' : 's'}, +${size.additions}/-${size.deletions}${packet.impactSummary ? `; ${packet.impactSummary}` : ''}.${changesSentence(names)}`,
      structured: withLimits(
        {
          diff: {
            status: comparison.status,
            ahead: comparison.aheadBy,
            behind: comparison.behindBy,
            files: comparison.files.slice(0, MAX_DIFF_FILES).map((file) => ({
              path: file.path,
              change: describeChangedFile(file)
            }))
          },
          ...(reviewLines.length > 0 ? { tree: reviewLines } : {}),
          changes: names,
          next: 'Ask for specific paths to inspect their patches, or forge_merge when the evidence is sufficient.'
        },
        reviewLimits
      )
    };
  }

  if (trimmedQuery && (isImpactQuery(trimmedQuery) || routed?.mode === 'impact')) {
    const patchPaths = comparison.files.slice(0, 20).map((file) => file.path);
    const enriched = patchPaths.length > 0
      ? await compare(gh, repo, base, change.branch, patchPaths)
      : comparison;
    const candidates = patchIdentifierCandidates(enriched.files, 100);
    const rankedIdentifiers = await rankImpactIdentifiersWithJev(ctx.env, change.name, candidates);
    const selected = rankedIdentifiers.slice(0, 3);
    const changedPaths = new Set(comparison.files.map((file) => file.path));
    const searched = await Promise.all(
      selected.map(async (identifier) => {
        const result = await searchGitHubCode(gh, `repo:${formatRepo(repo)} "${identifier.replaceAll('"', ' ')}"`, 10);
        const outside = result.items.filter((item) => item.path && !changedPaths.has(item.path));
        return { identifier, result, outside };
      })
    );
    const changes = await openChanges(ctx.gh, repo);
    const names = changeNames(changes);
    const evidenceLines = searched.map(({ identifier, result, outside }) =>
      `IMPACT? ${identifier} · ${result.total} matching file${result.total === 1 ? '' : 's'} on ${base} · ${outside.length} shown outside this change`
    );
    const resultFiles = searched.flatMap(({ identifier, outside }) =>
      outside.slice(0, 5).map((item) => ({
        path: `${identifier} → ${item.path ?? item.title}`,
        text: item.snippet ?? ''
      }))
    );
    const impactLimits = [
      ...limits,
      'Impact candidates are exact GitHub text-search evidence selected from removed patch identifiers; they are not compiler-backed references or proof of breakage.',
      ...(comparison.files.length > 20 ? [`Identifier extraction used patches from the first 20 of ${comparison.files.length} changed files.`] : []),
      ...(candidates.length >= 100 ? ['Identifier triage was capped at 100 removed patch candidates.'] : [])
    ];
    return {
      summary: `Impact search for "${change.name}": ${selected.length} identifier candidate${selected.length === 1 ? '' : 's'} searched against ${base}.${changesSentence(names)}`,
      structured: withLimits(
        {
          diff: {
            status: comparison.status,
            ahead: comparison.aheadBy,
            behind: comparison.behindBy,
            files: comparison.files.slice(0, MAX_DIFF_FILES).map((file) => ({ path: file.path, change: describeChangedFile(file) }))
          },
          tree: evidenceLines,
          ...(resultFiles.length > 0 ? { files: resultFiles } : {}),
          changes: names,
          next: resultFiles.length > 0
            ? 'Read the candidate paths before treating any text occurrence as a real dependency.'
            : 'No outside-change text candidates were shown; use specific paths or a semantic diff query for other review angles.'
        },
        impactLimits
      )
    };
  }

  if (trimmedQuery && (isDependencyQuery(trimmedQuery) || routed?.mode === 'dependencies')) {
    const review = await readDependencyReview(gh, repo, base, change.branch);
    const vulnerabilities = review.changes.flatMap((dependency) =>
      dependency.vulnerabilities.map((vulnerability) => ({ dependency, vulnerability }))
    );
    const added = review.changes.filter((dependency) => dependency.change === 'added').length;
    const removed = review.changes.filter((dependency) => dependency.change === 'removed').length;
    const shown = review.changes.slice(0, 100);
    const dependencyLimits = [
      ...limits,
      ...(review.unavailable ? [review.unavailable] : []),
      ...(review.snapshotWarning ? [`GitHub dependency snapshot warning: ${review.snapshotWarning}`] : []),
      ...(review.truncated ? ['Showing dependency changes from the first 300 results only.'] : [])
    ];
    return {
      summary: `"${change.name}" dependency review: ${added} added, ${removed} removed${vulnerabilities.length ? `; ${vulnerabilities.length} vulnerability finding${vulnerabilities.length === 1 ? '' : 's'}` : ''}.${changesSentence(changeNames(await openChanges(ctx.gh, repo)))}`,
      structured: withLimits(
        {
          diff: {
            status: comparison.status,
            ahead: comparison.aheadBy,
            behind: comparison.behindBy,
            files: []
          },
          files: shown.map((dependency) => ({
            path: dependency.manifest,
            text: `${dependency.change.toUpperCase()} ${dependency.ecosystem}:${dependency.name}@${dependency.version}` +
              `${dependency.scope ? ` · ${dependency.scope}` : ''}` +
              `${dependency.license ? ` · ${dependency.license}` : ''}` +
              `${dependency.vulnerabilities.length ? ` · ${dependency.vulnerabilities.map((vulnerability) => `${vulnerability.severity} ${vulnerability.advisoryId}: ${vulnerability.summary}`).join('; ')}` : ''}`
          })),
          changes: changeNames(await openChanges(ctx.gh, repo)),
          next: vulnerabilities.length > 0
            ? 'Inspect the vulnerable dependency changes before merging.'
            : 'Use stats or a semantic query to inspect the rest of the change.'
        },
        dependencyLimits
      )
    };
  }

  if (trimmedQuery && (isPolicyQuery(trimmedQuery) || routed?.mode === 'policy')) {
    const policy = await readBranchPolicy(gh, repo, base);
    const checks = requiredCheckNames(policy);
    const policyLimits = [
      ...limits,
      ...(policy.unavailable ? [policy.unavailable] : []),
      ...(policy.truncated ? ['GitHub returned more than 100 active branch rules; this list is incomplete.'] : [])
    ];
    return {
      summary: `"${change.name}" targets ${base}, which has ${policy.rules.length} active branch rule${policy.rules.length === 1 ? '' : 's'}${checks.length ? ` and requires: ${checks.join(', ')}` : ''}.${changesSentence(changeNames(await openChanges(ctx.gh, repo)))}`,
      structured: withLimits(
        {
          diff: {
            status: comparison.status,
            ahead: comparison.aheadBy,
            behind: comparison.behindBy,
            files: comparison.files.slice(0, MAX_DIFF_FILES).map((file) => ({ path: file.path, change: describeChangedFile(file) }))
          },
          tree: policy.rules.map((rule) => `RULE ${rule.type}`),
          changes: changeNames(await openChanges(ctx.gh, repo)),
          next: checks.length > 0
            ? 'GitHub enforces these requirements at merge time; Forge does not currently have permission to read the check results.'
            : 'When this change is right, forge_merge asks a human to land it.'
        },
        policyLimits
      )
    };
  }

  if (trimmedQuery && (isStatsQuery(trimmedQuery) || routed?.mode === 'stats')) {
    const scope = statsScope(trimmedQuery);
    const scoped = scope
      ? comparison.files.filter((file) => file.path === scope || file.path.startsWith(`${scope}/`))
      : comparison.files;
    if (scope && scoped.length === 0) limits.push(`No changed files were found under ${scope}.`);
    ordered = [...scoped].sort(
      (left, right) => right.additions + right.deletions - (left.additions + left.deletions) || left.path.localeCompare(right.path)
    );
    const scopedSize = fileTotals(scoped);
    const hotspots = changeHotspots(scoped);
    statsNote = `; ${scope ? `scope ${scope}: ` : ''}${scopedSize.files} file${scopedSize.files === 1 ? '' : 's'} +${scopedSize.additions}/-${scopedSize.deletions}`;
    if (hotspots.length > 0) statsNote += `; hotspots ${hotspots.join(', ')}`;
  } else if (trimmedQuery && ordered.length > 1) {
    const pathRanked = await rankChangeFilesWithJev(ctx.env, ordered, trimmedQuery);
    const candidatePaths =
      ordered.length <= 20
        ? ordered.map((file) => file.path)
        : (pathRanked && pathRanked.length > 0 ? pathRanked : ordered.map((file) => file.path)).slice(0, 20);

    let semanticOrder = pathRanked;
    if (ctx.env.TYPESAFE_API_KEY && candidatePaths.length > 0) {
      try {
        const withPatches = await compare(gh, repo, base, change.branch, candidatePaths);
        const candidateSet = new Set(candidatePaths);
        const enriched = withPatches.files.filter((file) => candidateSet.has(file.path));
        const patchRanked = await rankChangeFilesWithJev(ctx.env, enriched, trimmedQuery);
        if (patchRanked && patchRanked.length > 0) semanticOrder = patchRanked;

        const allHunks = splitPatchHunks(enriched, 200);
        const hunkCandidates = representativePatchHunks(allHunks, trimmedQuery, 120);
        const rankedHunks = await rankPatchHunksWithJev(ctx.env, hunkCandidates, trimmedQuery);
        const hunkById = new Map(hunkCandidates.map((hunk) => [hunk.id, hunk]));
        for (const ranked of rankedHunks) {
          const hunk = hunkById.get(ranked.id);
          if (!hunk) continue;
          const existing = semanticPatchByPath.get(hunk.path);
          semanticPatchByPath.set(
            hunk.path,
            existing ? `${existing}\n${hunk.text}` : hunk.text
          );
        }
        if (allHunks.length > hunkCandidates.length) {
          limits.push(`Jev hunk targeting considered ${hunkCandidates.length} representative hunks from ${allHunks.length} patch hunks.`);
        }
        if (rankedHunks.length > 0) {
          limits.push('Patch snippets shown for semantic change questions are Jev-selected relevant hunks, not necessarily the full file diff. Ask for a path to see its full patch.');
        }
      } catch {
        // Path semantics still provide a useful fallback if patch enrichment fails.
      }
    }

    if (semanticOrder && semanticOrder.length > 0) {
      semanticallyRanked = true;
      const askedFiles = ordered.filter((file) => asked.has(file.path));
      const askedSet = new Set(askedFiles.map((file) => file.path));
      const rankedSet = new Set(semanticOrder);
      ordered = [
        ...askedFiles,
        ...ordered
          .filter((file) => !askedSet.has(file.path) && rankedSet.has(file.path))
          .sort((left, right) => semanticOrder.indexOf(left.path) - semanticOrder.indexOf(right.path)),
        ...ordered.filter((file) => !askedSet.has(file.path) && !rankedSet.has(file.path))
      ];
    }
  }
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

    const queryNote = semanticallyRanked ? ` (diff-ranked for "${trimmedQuery}")` : "";
    return {
      summary: `"${change.name}" is ${comparison.status} against ${base}: ${size.files} file${size.files === 1 ? "" : "s"}, +${size.additions}/-${size.deletions}${statsNote}${queryNote}.${changesSentence(names)}`,
    structured: withLimits(
      {
        diff: {
          status: comparison.status,
          ahead: comparison.aheadBy,
          behind: comparison.behindBy,
          files: shown.map((file) => ({
            path: file.path,
            change: describeChangedFile(file),
            ...(
              asked.has(file.path) && file.patch !== undefined
                ? { patch: file.patch }
                : semanticPatchByPath.has(file.path)
                  ? { patch: semanticPatchByPath.get(file.path)! }
                  : file.patch === undefined
                    ? {}
                    : { patch: file.patch }
            )
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
  const repo = await resolveRepoTarget(ctx, repoInput);
  const base = await defaultBranch(ctx.gh, repo);
  const change = await findChange(ctx.gh, repo, wanted);
  const comparison = await compare(ctx.gh, repo, base, change.branch);
  const head = await headSha(ctx.gh, repo, change.branch);
  const size = totals(comparison);
  const review = act === 'merge'
    ? await buildChangeReviewPacket(ctx.env, ctx.gh, repo, base, change, comparison)
    : null;
  const impactSummary = review?.impactSummary;

  // `change` goes in as it came out of GitHub, without `stats` copied onto it:
  // the comparison stored beside it already carries those numbers, and a
  // second copy of a measurement is a second thing that can disagree.
  const approval = await requestApproval(ctx.env, ctx.identity, {
    act,
    repo,
    change,
    comparison,
    headSha: head,
    baseBranch: base,
    ...(impactSummary ? { impactSummary } : {})
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

  const impactNote = impactSummary ? ` [${impactSummary}]` : '';

  const evidence =
    act === 'merge'
      ? `Merging "${change.name}" into ${base} brings ${commits}: ${files}.${impactNote}`
      : `Discarding "${change.name}" drops ${files}. ${loss}${impactNote ? ' ' + impactNote : ''}`;

  const limits: string[] = [];
  if (review) limits.push(...changeReviewNotices(review, comparison, base));
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
        repo: z.string().optional().describe('owner/name, a bare reachable repo name, or "global" for public GitHub search. Omit to list your repositories.'),
        change: z.string().optional().describe('An open change, named by the words that created it.'),
        paths: z.array(z.string()).max(20).optional(),
        query: z.string().optional().describe('Question or filter over GitHub state: code, size/shape, history, hygiene, migrations, quality, dependencies, languages, or branch policy.')
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
        const repoStr = input.repo?.trim();
        if (repoStr === 'global' || repoStr === 'search' || repoStr === 'public') {
          return searchGlobal(ctx, input.query ?? '');
        }

        if (input.repo === undefined) {
          if (input.change !== undefined || input.paths !== undefined) {
            throw new ForgeError({
              code: 'FORGE_VALIDATION_FAILED',
              message: 'Say which repository, as owner/name. Call forge_read with no arguments to list them.'
            });
          }
          return readRepositories(ctx, input.query);
        }

        const repo = await resolveRepoTarget(ctx, input.repo);
        if (input.change !== undefined) return readChangeLevel(ctx, repo, input.change, input.paths, input.query);
        if (input.paths !== undefined && input.paths.length > 0) return readFilesLevel(ctx, repo, input.paths, input.query);
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
        intent: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Deprecated compatibility input for cached clients. It always means proposed/review work; use change instead.'),
        files: z.array(fileInput).min(1).max(10),
        message: z.string().trim().min(1).optional().describe('Commit message saying what changed. Required for new direct edits; cached clients may fall back to intent.'),
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
        const repo = await resolveRepoTarget(ctx, input.repo);
        const requestedChange = input.change?.trim();
        const legacyIntent = input.intent?.trim();
        if (requestedChange && legacyIntent && requestedChange !== legacyIntent) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'This edit supplied both change and deprecated intent with different values. Refresh the Forge connection and send only change.',
            details: { fields: ['change', 'intent'] }
          });
        }

        const usedLegacyCatalog = !requestedChange && Boolean(legacyIntent);
        const change = requestedChange ?? legacyIntent;
        const message = input.message?.trim() || change;
        if (!message) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'Give this edit a commit message. If your client still shows intent instead of change, refresh the Forge connection first.'
          });
        }

        const { base, created } = await resolveWriteTarget(ctx, repo, message, input.private ?? true);
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
        const limits: string[] = [...(commit.notes ?? [])];
        if (usedLegacyCatalog) {
          limits.push(
            'This edit used the deprecated intent input from cached MCP metadata. Forge preserved the old safe behavior by keeping the work on the review branch. Refresh the Forge connection and start a new conversation before further edits.'
          );
        }

        let number: number | null = null;
        try {
          if (change !== undefined) number = await ensureDraftPullRequest(ctx.gh, repo, branch, change, base);
        } catch (error) {
          limits.push(
            `The work is committed, but its review pull request could not be opened: ${toForgeError(error).message} ` +
              'The branch exists on GitHub either way.'
          );
        }

        if (commit.outcome === 'committed') {
          try {
            const committedGh = ctx.gh;
            const committedTree = await readTree(committedGh, repo, commit.sha);
            if (committedTree.truncated) {
              limits.push('Post-commit advisory was skipped because GitHub truncated the committed tree.');
            } else {
              const knownPaths = committedTree.entries
                .filter((entry) => entry.type === 'file')
                .map((entry) => entry.path);
              const knownSet = new Set(knownPaths);
              const liveChangedPaths = commit.paths.filter((path) => knownSet.has(path));
              if (liveChangedPaths.length > 0) {
                const committedFiles = await readFiles(
                  committedGh,
                  repo,
                  commit.sha,
                  liveChangedPaths,
                  POST_COMMIT_FILE_BYTES
                );
                for (const skipped of committedFiles.skipped) {
                  limits.push(`Post-commit advisory skipped ${skipped.path}: ${skipped.reason}.`);
                }
                const lintWarnings = await lintCommittedFiles(
                  committedFiles.files
                    .filter((file) => !file.truncated)
                    .map((file) => ({ path: file.path, content: file.content })),
                  knownPaths
                );
                limits.push(...lintWarnings);

                if (commit.paths.some(isDependencyManifestPath)) {
                  const parent = await readCommitParents(committedGh, repo, commit.sha);
                  if (parent.unavailable) limits.push(parent.unavailable);
                  if (parent.parents[0]) {
                    const review = await readDependencyReview(committedGh, repo, parent.parents[0], commit.sha);
                    if (review.unavailable) limits.push(review.unavailable);
                    if (review.snapshotWarning) limits.push(`GitHub dependency snapshot warning: ${review.snapshotWarning}`);
                    const added = review.changes.filter((dependency) => dependency.change === 'added').length;
                    const removed = review.changes.filter((dependency) => dependency.change === 'removed').length;
                    const vulnerabilities = review.changes.flatMap((dependency) =>
                      dependency.vulnerabilities.map((vulnerability) => ({ dependency, vulnerability }))
                    );
                    if (review.changes.length > 0) {
                      limits.push(`Post-commit dependency review: ${added} added, ${removed} removed.`);
                    }
                    for (const finding of vulnerabilities.slice(0, 10)) {
                      limits.push(
                        `Post-commit dependency notice: ${finding.vulnerability.severity} ${finding.vulnerability.advisoryId} on ${finding.dependency.name}@${finding.dependency.version} — ${finding.vulnerability.summary}`
                      );
                    }
                    if (vulnerabilities.length > 10) {
                      limits.push(`GitHub reported ${vulnerabilities.length} dependency vulnerability findings; showing the first 10.`);
                    }
                    if (review.truncated) limits.push('Post-commit dependency review was capped at 300 dependency changes.');
                  }
                }

                if (commit.paths.some(isCodeownersPath)) {
                  const ownership = await readCodeownersErrors(committedGh, repo, commit.sha);
                  if (ownership.unavailable) limits.push(ownership.unavailable);
                  for (const error of ownership.errors.slice(0, 10)) {
                    const where = error.line ? ` line ${error.line}${error.column ? `:${error.column}` : ''}` : '';
                    limits.push(`Post-commit CODEOWNERS notice${where}: ${error.message}${error.suggestion ? ` ${error.suggestion}` : ''}`);
                  }
                  if (ownership.errors.length > 10) {
                    limits.push(`GitHub reported ${ownership.errors.length} CODEOWNERS errors; showing the first 10.`);
                  }
                }
              }
            }
          } catch {
            // The commit is already durable. Advisory analysis may disappear, never turn success into failure.
            limits.push('Post-commit advisory checks could not be completed; the GitHub commit itself is still durable.');
          }
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
            try {
              const removed = await ctx.gh(`/repos/${repo.owner}/${repo.name}/git/refs/heads/${ref}`, {
                method: 'DELETE'
              });
              if (removed.status >= 200 && removed.status < 300) {
                limits.push('No Forge change was opened, because there was nothing to put in it.');
              } else {
                limits.push(
                  `No content changed, but Forge could not remove the unused review branch (GitHub HTTP ${removed.status}). The branch contains no new commit.`
                );
              }
            } catch {
              limits.push(
                'No content changed, but Forge could not confirm removal of the unused review branch. The branch contains no new commit.'
              );
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
        quota: z.string().optional(),
        pointer: z
          .object({
            suspect: z.string().nullable(),
            exists: z.number(),
            next: z.enum(['read', 'stop']),
            isErrorPage: z.boolean(),
            pageType: z.string().optional(),
            hasUnlabeledControls: z.boolean().optional()
          })
          .optional()
          .describe(
            'Jev pointer on the accessibility outline (not the screenshot). Use suspect as forge_read query. next=stop means do not guess a code fix from this capture.'
          ),
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

        let pointer: Awaited<ReturnType<typeof judgeSeePacket>> = null;
        let jevInsightNote = '';
        if (shot.outline.length > 0) {
          pointer = await judgeSeePacket(ctx.env, input.url, shot.title, shot.outline);
          if (pointer) {
            if (pointer.pageType && pointer.pageType !== 'error') {
              jevInsightNote += ` [Type: ${pointer.pageType}]`;
            }
            if (pointer.suspect) jevInsightNote += ` Pointer: ${pointer.suspect}.`;
            if (pointer.hasUnlabeledControls) {
              limits.push('Jev notice: detected potentially unlabeled or missing-name interactive controls in page outline.');
            }
            if (pointer.isErrorPage) {
              limits.push('Jev: this outline looks like an error, login, or challenge page — do not invent a product bug.');
            }
            if (pointer.next === 'stop') {
              limits.push('Jev next=stop: do not forge_read or forge_edit from this capture; ask for another public URL.');
            } else if (pointer.suspect) {
              limits.push(`Use forge_read with query ${JSON.stringify(pointer.suspect)} to open the file that owns this landmark.`);
            }
          }
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
          summary: `Captured ${shot.title ? `"${shot.title}"` : shot.url} at ${shown.join(' and ')}.${jevInsightNote}${quota.unlimited ? '' : ` ${quota.used} of ${quota.limit} captures used today.`}`,
          structured: withLimits(
            {
              page: { url: shot.url, title: shot.title, shown },
              ...(quota.unlimited ? {} : { quota: `${quota.used} of ${quota.limit} used today` }),
              ...(pointer
                ? {
                    pointer: {
                      suspect: pointer.suspect,
                      exists: pointer.exists,
                      next: pointer.next,
                      isErrorPage: pointer.isErrorPage,
                      ...(pointer.pageType ? { pageType: pointer.pageType } : {}),
                      ...(pointer.hasUnlabeledControls ? { hasUnlabeledControls: pointer.hasUnlabeledControls } : {})
                    }
                  }
                : {})
            },
            limits
          ),
          content
        };
      })
  );
}
