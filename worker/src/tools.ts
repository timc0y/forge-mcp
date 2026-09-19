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
import { assessChangeWithJev, changeAssessmentNotices, judgeSeePacket, rankChangeFilesWithJev, resolveRepoWithJev, semanticFileExcerpt, semanticPathTriageDetailed, suggestCommitMessageWithJev, summarizeChangeAssessment } from './jev';
import {
  changeHotspots,
  exactFindNeedle,
  fileTotals,
  humanBytes,
  isDependencyManifestPath,
  isDependencyQuery,
  isMapQuery,
  isPolicyQuery,
  isStatsQuery,
  lintCommittedFiles,
  repositoryMap,
  repositoryStats,
  semanticCodeNeedle,
  statsScope
} from './repository-intelligence';
import { CHANGE_BRANCH, ensureDraftPullRequest, findChange, openChanges, openChangesTruncated } from './change';
import { readBranchPolicy, readDependencyReview, requiredCheckNames } from './github-intelligence';
import { commitFiles } from './write';
import { assertNotNearExisting, createRepo, defaultBranch } from './repo';
import {
  SUPPORTED_PLATFORMS,
  buildAdvancedSearchQuery,
  rankSearchResultsWithJev,
  resolveDocPlatform,
  searchGitHubCode,
  searchGitHubRepos
} from './search';
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
async function resolveRepoTarget(ctx: ToolContext, value: string): Promise<RepoRef> {
  const trimmed = value.trim();

  // If already a valid canonical owner/name format, return directly
  if (trimmed.includes("/")) {
    try {
      return parseRepo(trimmed);
    } catch {
      // If owner/name has spaces or typos, allow fuzzy resolution against reachable repos
    }
  }

  // Check if it matches a known documentation platform alias (e.g. "cloudflare", "nextjs", "react", "mdn")
  const platform = resolveDocPlatform(trimmed);
  if (platform) {
    return platform.repo;
  }

  // Check reachable repos for exact, normalized, or Jev semantic match
  try {
    const repos = await listRepos(ctx.gh);

    // 1. Exact match against owner/name or repo name (case-insensitive)
    const exactNameMatches = repos.filter((r) => {
      const parts = r.repo.split("/");
      return (
        parts[1]?.toLowerCase() === trimmed.toLowerCase() ||
        r.repo.toLowerCase() === trimmed.toLowerCase()
      );
    });
    if (exactNameMatches.length === 1 && exactNameMatches[0]) {
      return parseRepo(exactNameMatches[0].repo);
    }

    // 2. Normalized alphanumeric match (e.g. "easy roads" -> "easyroads" matches "EasyRoads")
    const cleanQuery = trimmed.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (cleanQuery.length > 0) {
      const normalizedMatches = repos.filter((r) => {
        const repoName = (r.repo.split("/")[1] ?? r.repo).toLowerCase().replace(/[^a-z0-9]/g, "");
        const fullRepo = r.repo.toLowerCase().replace(/[^a-z0-9]/g, "");
        return repoName === cleanQuery || fullRepo === cleanQuery;
      });
      if (normalizedMatches.length === 1 && normalizedMatches[0]) {
        return parseRepo(normalizedMatches[0].repo);
      }
    }

    // 3. Jev semantic / fuzzy repository resolution
    if (ctx.env.TYPESAFE_API_KEY && repos.length > 0) {
      const match = await resolveRepoWithJev(ctx.env, trimmed, repos);
      if (match && match.confidence >= 0.8) {
        return parseRepo(match.repo);
      }
    }
  } catch {
    // If listing fails, fall through to default parse
  }

  // 4. Default: parse as user's own repo (or throw standard validation error if invalid)
  return parseRepo(trimmed.includes("/") ? trimmed : `${ctx.identity.githubLogin}/${trimmed}`);
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

function ghForRepo(ctx: ToolContext, repo: RepoRef): GitHubRequest {
  return async (path, init) => {
    const res = await ctx.gh(path, init);
    if ((res.status === 404 || res.status === 403) && ctx.ghUser) {
      try {
        const userRes = await ctx.ghUser(path, init);
        if (userRes.status === 200 || res.status !== 404) {
          return userRes;
        }
      } catch {
        // Fall back to original res
      }
    }
    return res;
  };
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
  platforms: z
    .array(
      z.object({
        name: z.string(),
        repo: z.string(),
        description: z.string()
      })
    )
    .optional(),
  ...receiptFields
};

async function searchGlobalOrDocs(
  ctx: ToolContext,
  targetRepo: string | undefined,
  query: string
): Promise<ToolOutcome> {
  const gh = ctx.ghUser ?? ctx.gh;
  const isTargetDocs = targetRepo === 'docs';
  const isTargetGlobal = targetRepo === 'global' || targetRepo === 'search' || targetRepo === 'public';

  const platform =
    targetRepo && !isTargetDocs && !isTargetGlobal
      ? resolveDocPlatform(targetRepo)
      : isTargetGlobal
        ? null
        : resolveDocPlatform(query);

  const isDocsMode = (isTargetDocs || Boolean(platform)) && !isTargetGlobal;
  const mode = isDocsMode
    ? 'docs'
    : /\b(repo|repos|repository|repositories|libraries)\b/i.test(query)
      ? 'repos'
      : 'code';

  if (isDocsMode && !platform && (!query || query.trim() === '')) {
    return {
      summary: `Forge Documentation Search supports: ${SUPPORTED_PLATFORMS.map((p) => p.name).join(', ')}.`,
      structured: {
        platforms: SUPPORTED_PLATFORMS.map((p) => ({
          name: p.name,
          repo: formatRepo(p.repo),
          description: p.description
        })),
        next: 'Specify repo: "<platform>" (e.g. repo: "cloudflare") and a query to search documentation.'
      }
    };
  }

  const { query: advancedQuery, detectedPlatform, intentMode } = await buildAdvancedSearchQuery(ctx.env, query, mode);
  const activePlatform = isTargetGlobal ? null : (platform ?? detectedPlatform);
  const effectiveMode = activePlatform ? 'docs' : (intentMode ?? mode);

  const limits: string[] = [];

  if (effectiveMode === 'repos') {
    const { total, items } = await searchGitHubRepos(gh, advancedQuery, 10);
    const ranked = await rankSearchResultsWithJev(ctx.env, query, items);

    if (ranked.length === 0) {
      return {
        summary: `No public GitHub repositories matched "${query}".`,
        structured: {
          searchResults: [],
          next: 'Try broader search terms, or specify repo: "docs" with a platform name like "cloudflare" or "nextjs".'
        }
      };
    }

    return {
      summary: `Found ${total} public GitHub repositor${total === 1 ? 'y' : 'ies'} for "${query}" (advanced query: \`${advancedQuery}\`).`,
      structured: withLimits(
        {
          repos: ranked.map((r) => ({
            repo: r.repo,
            about: [r.snippet, r.stars ? `⭐ ${r.stars}` : '', r.url].filter(Boolean).join(' · ')
          })),
          searchResults: ranked,
          next: 'Pass repo: "<owner>/<name>" to inspect tree or files of any of these repositories.'
        },
        limits
      )
    };
  }

  // Code / Documentation search
  const { total, items } = await searchGitHubCode(gh, advancedQuery, 10);
  const ranked = await rankSearchResultsWithJev(ctx.env, query, items);

  const scopeLabel = activePlatform
    ? `${activePlatform.name} documentation (${formatRepo(activePlatform.repo)})`
    : 'public GitHub code';

  if (ranked.length === 0) {
    return {
      summary: `No code matches found across ${scopeLabel} for "${query}" (query: \`${advancedQuery}\`).`,
      structured: {
        searchResults: [],
        next: 'Try broader keywords or omit language/path qualifiers.'
      }
    };
  }

  return {
    summary: `Found ${total} code matches across ${scopeLabel} for "${query}".`,
    structured: withLimits(
      {
        files: ranked.map((item) => ({
          path: item.path ? `${item.repo}:${item.path}` : item.title,
          text: item.snippet ?? ''
        })),
        searchResults: ranked,
        next: activePlatform
          ? `Read full doc file with repo: "${formatRepo(activePlatform.repo)}" and paths: ["${ranked[0]?.path ?? '...'}"]`
          : 'Read any matching file with repo: "<owner>/<name>" and paths: ["..."]'
      },
      limits
    )
  };
}

async function readRepositories(ctx: ToolContext, query: string | undefined): Promise<ToolOutcome> {
  const trimmedQuery = query?.trim();

  // If query starts with search/docs prefix
  if (trimmedQuery && /^(global|search|code|docs|platform):/i.test(trimmedQuery)) {
    const cleanQuery = trimmedQuery.replace(/^(global|search|code|docs|platform):\s*/i, '');
    const isDocs = /^docs:/i.test(trimmedQuery);
    return searchGlobalOrDocs(ctx, isDocs ? 'docs' : 'global', cleanQuery);
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
      return searchGlobalOrDocs(ctx, 'global', trimmedQuery);
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
  const gh = ghForRepo(ctx, repo);
  const base = await defaultBranch(gh, repo);
  const [tree, changes] = await Promise.all([
    readTree(gh, repo, base),
    openChanges(ctx.gh, repo)
  ]);

  const allFilePaths = tree.entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => entry.path);
  const names = changeNames(changes);
  const trimmedQuery = query?.trim();

  if (trimmedQuery && isStatsQuery(trimmedQuery)) {
    const scope = statsScope(trimmedQuery);
    const scopedEntries = scope
      ? tree.entries.filter((entry) => entry.path === scope || entry.path.startsWith(`${scope}/`))
      : tree.entries;
    const stats = repositoryStats(scopedEntries);
    const limits = [
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

  if (trimmedQuery && isMapQuery(trimmedQuery)) {
    const lines = repositoryMap(tree.entries);
    const limits = [
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

  if (trimmedQuery && isPolicyQuery(trimmedQuery)) {
    const policy = await readBranchPolicy(gh, repo, base);
    const checks = requiredCheckNames(policy);
    const lines = policy.rules.map((rule) => {
      if (rule.type === 'required_status_checks' && checks.length > 0) {
        return `RULE required_status_checks · ${checks.join(', ')}`;
      }
      const source = [rule.sourceType, rule.source].filter(Boolean).join(' · ');
      return `RULE ${rule.type}${source ? ` · ${source}` : ''}`;
    });
    const limits = [
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

  const findNeedle = trimmedQuery ? exactFindNeedle(trimmedQuery) : null;
  if (findNeedle) {
    const safeNeedle = findNeedle.replaceAll('"', ' ');
    const found = await searchGitHubCode(gh, `repo:${formatRepo(repo)} "${safeNeedle}"`, 25);
    const ranked = await rankSearchResultsWithJev(ctx.env, findNeedle, found.items);
    const shown = ranked.slice(0, 25);
    const uniquePaths = [...new Set(shown.map((item) => item.path).filter((path): path is string => Boolean(path)))];
    const limits = [
      ...(found.total > shown.length ? [`Showing ${shown.length} of ${found.total} code results.`] : []),
      ...changesLimits(changes)
    ];

    const counts = new Map<string, number>();
    if (uniquePaths.length > 0) {
      try {
        const measured = await readFiles(gh, repo, base, uniquePaths.slice(0, 10), MAX_FILE_BYTES);
        for (const file of measured.files) {
          if (!file.truncated) counts.set(file.path, file.content.split(findNeedle).length - 1);
        }
        if (uniquePaths.length > 10 || measured.skipped.length > 0) {
          limits.push('Exact occurrence counts are measured only for complete matching files that fit the read budget; search paths remain the discovery result.');
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
              text: `${count === undefined ? '' : `${count} exact occurrence${count === 1 ? '' : 's'} · `}${item.snippet ?? ''}`
            };
          }),
          changes: names,
          next:
            uniquePaths.length > 0
              ? 'Use these paths with forge_edit fragment replacements and all:true when every exact occurrence in that file should change. A write is capped at 10 files.'
              : 'Try a shorter exact term, or use "code:<concept>" for semantic committed-code search.'
        },
        limits
      )
    };
  }

  const codeNeedle = trimmedQuery ? semanticCodeNeedle(trimmedQuery) : null;
  if (codeNeedle) {
    const built = await buildAdvancedSearchQuery(ctx.env, codeNeedle, 'code');
    const withoutRepo = built.query.replace(/(?:^|\s)repo:[^\s]+/gi, ' ').trim();
    const found = await searchGitHubCode(gh, `repo:${formatRepo(repo)} ${withoutRepo}`, 15);
    const ranked = await rankSearchResultsWithJev(ctx.env, codeNeedle, found.items);
    const shown = ranked.slice(0, 15);
    const uniquePaths = [...new Set(shown.map((item) => item.path).filter((path): path is string => Boolean(path)))];
    const limits = [
      ...(found.total > shown.length ? [`Showing ${shown.length} of ${found.total} committed-code results.`] : []),
      ...changesLimits(changes)
    ];
    return {
      summary: `Found ${found.total} committed-code result${found.total === 1 ? '' : 's'} for "${codeNeedle}" in ${formatRepo(repo)}; semantically ranked.${changesSentence(names)}`,
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
      // plainly present in committed code. Only pay for code search when the
      // cheap path answers produced nothing; GitHub remains the index.
      if (paths.length === 0 && trimmed.length >= 3) {
        try {
          const built = await buildAdvancedSearchQuery(ctx.env, trimmed, 'code');
          const withoutRepo = built.query.replace(/(?:^|\s)repo:[^\s]+/gi, ' ').trim();
          const found = await searchGitHubCode(gh, `repo:${formatRepo(repo)} ${withoutRepo}`, 10);
          const ranked = await rankSearchResultsWithJev(ctx.env, trimmed, found.items);
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

  const shown = paths.slice(0, MAX_TREE_ENTRIES);

  const limits: string[] = [];
  if (semanticCoverageNote) limits.push(semanticCoverageNote);
  if (paths.length > shown.length) {
    limits.push(`Showing ${shown.length} of ${paths.length} files. Pass query to narrow the list.`);
  }
  if (tree.truncated) {
    limits.push('GitHub truncated this listing, so some files are missing from it.');
  }

  const fileExcerpts: Array<{ path: string; text: string }> = [...contentFallbackExcerpts];
  if (isSemanticSearch && paths.length > 0 && ctx.env.TYPESAFE_API_KEY) {
    try {
      const topCandidates = paths.slice(0, 2);
      const readResult = await readFiles(gh, repo, base, topCandidates, MAX_FILE_BYTES);
      for (const candidateFile of readResult.files) {
        if (!candidateFile.truncated) {
          const excerpt = await semanticFileExcerpt(ctx.env, candidateFile.path, candidateFile.content, query!.trim());
          if (excerpt && excerpt.confidence >= 0.4) {
            fileExcerpts.push({
              path: `${candidateFile.path} (lines ${excerpt.startLine}-${excerpt.endLine})`,
              text: excerpt.content
            });
          }
        }
      }
    } catch {
      // Degrade gracefully to listing only
    }
  }

  const queryNote = isSemanticSearch
    ? ` matching "${query?.trim()}" (semantically ranked by Jev across ${allFilePaths.length} files)`
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

async function readFilesLevel(
  ctx: ToolContext,
  repo: RepoRef,
  paths: string[],
  query?: string
): Promise<ToolOutcome> {
  const gh = ghForRepo(ctx, repo);
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
  const gh = ghForRepo(ctx, repo);
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
  const trimmedQuery = query?.trim();

  if (trimmedQuery && isDependencyQuery(trimmedQuery)) {
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

  if (trimmedQuery && isPolicyQuery(trimmedQuery)) {
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

  if (trimmedQuery && isStatsQuery(trimmedQuery)) {
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
  const repo = await resolveRepoTarget(ctx, repoInput);
  const base = await defaultBranch(ctx.gh, repo);
  const change = await findChange(ctx.gh, repo, wanted);
  const comparison = await compare(ctx.gh, repo, base, change.branch);
  const head = await headSha(ctx.gh, repo, change.branch);
  const size = totals(comparison);
  const dependencyFilesChanged = comparison.files.some((file) => isDependencyManifestPath(file.path));
  const [policy, dependencies] = act === 'merge'
    ? await Promise.all([
        readBranchPolicy(ctx.gh, repo, base).catch(() => ({ rules: [], truncated: false })),
        dependencyFilesChanged
          ? readDependencyReview(ctx.gh, repo, base, change.branch).catch(() => ({ changes: [], truncated: false }))
          : Promise.resolve({ changes: [], truncated: false })
      ])
    : [{ rules: [], truncated: false }, { changes: [], truncated: false }];
  const requiredChecks = requiredCheckNames(policy);
  const dependencyVulnerabilities = dependencies.changes.flatMap((dependency) => dependency.vulnerabilities);

  let assessment = null;
  let impactSummary: string | undefined;
  if (act === 'merge' && ctx.env.TYPESAFE_API_KEY && comparison.files.length > 0) {
    try {
      const patchPaths = comparison.files.slice(0, 20).map((file) => file.path);
      const enriched = await compare(ctx.gh, repo, base, change.branch, patchPaths);
      assessment = await assessChangeWithJev(ctx.env, change.name, enriched);
      if (assessment) impactSummary = summarizeChangeAssessment(assessment, comparison.files.length);
    } catch {
      // Approval remains useful with deterministic GitHub evidence alone.
    }
  }

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
  if (assessment) limits.push(...changeAssessmentNotices(assessment, comparison));
  if (comparison.truncated) {
    limits.push('GitHub truncated this comparison, so the file counts above are a floor, not a total.');
  }
  if (act === 'merge' && comparison.behindBy > 0) {
    limits.push(`This change is ${comparison.behindBy} commit${comparison.behindBy === 1 ? '' : 's'} behind ${base}; GitHub decides at merge time whether it still applies cleanly.`);
  }
  if (act === 'merge' && requiredChecks.length > 0) {
    limits.push(`GitHub requires these checks on ${base}: ${requiredChecks.join(', ')}. Forge can see the rule names but not their current pass/fail state with its present permissions.`);
  }
  if (act === 'merge' && dependencyVulnerabilities.length > 0) {
    const highest = dependencyVulnerabilities
      .map((finding) => finding.severity)
      .filter(Boolean)
      .join(', ');
    limits.push(`GitHub dependency review reports ${dependencyVulnerabilities.length} vulnerability finding${dependencyVulnerabilities.length === 1 ? '' : 's'} in dependency changes${highest ? ` (${highest})` : ''}. Inspect them before approving.`);
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
        query: z.string().optional().describe('Narrows semantically. Also: "stats [path]", "map", "find:<text>", "code:<concept>", "dependencies", or "policy".')
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
        const isGlobalSearch = repoStr === 'global' || repoStr === 'search' || repoStr === 'public';
        const isDocsSearch =
          repoStr === 'docs' ||
          (repoStr !== undefined && resolveDocPlatform(repoStr) !== null && input.paths === undefined && input.change === undefined);

        if (isGlobalSearch || (isDocsSearch && input.paths === undefined && input.change === undefined)) {
          return searchGlobalOrDocs(ctx, repoStr, input.query ?? '');
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
        const repo = await resolveRepoTarget(ctx, input.repo);
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
          input.files,
          ctx.env
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

        if (message.length < 15 || /^(update|fix|edits|test|patch)$/i.test(message)) {
          try {
            const suggestion = await suggestCommitMessageWithJev(ctx.env, input.files);
            if (suggestion) {
              limits.push(`Tip: consider conventional commit "${suggestion}" for clearer history.`);
            }
          } catch {
            // Non-fatal
          }
        }

        if (commit.outcome === 'committed') {
          try {
            const committedGh = ghForRepo(ctx, repo);
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
                const committedFiles = await readFiles(committedGh, repo, commit.sha, liveChangedPaths, MAX_FILE_BYTES);
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
              }
            }
          } catch {
            // The commit is already durable. Advisory analysis may disappear, never turn success into failure.
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
              ...(gallery === null ? {} : { gallery }),
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
