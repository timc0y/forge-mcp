/**
 * Small GitHub search helpers. GitHub is the index; Jev only ranks the bounded
 * results GitHub returns.
 */
import type { GitHubRequest, RepoRef } from './contracts';
import type { Env } from './env';
import { typesafeSystemOne } from './jev';

export interface SearchItem {
  id: string;
  title: string;
  repo: string;
  path?: string;
  snippet?: string;
  url?: string;
  stars?: number;
  score?: number;
  confidence?: number;
}

export interface SearchResultSet {
  total: number;
  items: SearchItem[];
  /** Present when GitHub did not answer successfully; never means zero matches. */
  unavailable?: string;
  /**
   * GitHub answered with `incomplete_results`, so what is here is a partial
   * answer. Never reported as a complete result count.
   */
  incomplete?: boolean;
}

function unavailableSearch(kind: 'repository' | 'code', status: number): SearchResultSet {
  const reason =
    status === 401 ? 'authentication was rejected' :
    status === 403 ? 'permission or rate limiting blocked the request' :
    status === 422 ? 'GitHub rejected the query' :
    status === 429 ? 'GitHub rate limited the request' :
    `GitHub returned HTTP ${status}`;
  return {
    total: 0,
    items: [],
    unavailable: `GitHub ${kind} search is unavailable: ${reason}. No absence conclusion was made.`
  };
}

/**
 * Deterministic query shaping. Native GitHub qualifiers always win; Forge only
 * adds obvious language and noise filters.
 */
/**
 * GitHub code search ANDs its terms, so a word that is not in the code kills
 * the whole query. Articles, prepositions and other filler are therefore not
 * neutral — they are the reason a natural phrase finds nothing while its two
 * distinctive words would have. A quoted phrase is left exactly as written.
 */
const SEARCH_FILLER = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'could', 'do', 'does',
  'for', 'from', 'how', 'i', 'in', 'into', 'is', 'it', 'my', 'of', 'on', 'or',
  'our', 'should', 'that', 'the', 'their', 'this', 'to', 'was', 'we', 'what',
  'when', 'where', 'which', 'who', 'why', 'with', 'without', 'would', 'you', 'your'
]);

const LANGUAGE_WORDS = new Set([
  'typescript', 'ts', 'javascript', 'js', 'python', 'py', 'rust', 'rs', 'golang', 'go'
]);

/** The terms of a natural query, minus filler and the word that became a language filter. */
function searchTerms(query: string): string {
  if (query.includes('"')) return query;
  const kept = query.split(/\s+/).filter((word) => {
    const clean = word.toLowerCase().replace(/[^a-z0-9]/g, '');
    return clean.length > 0 && !SEARCH_FILLER.has(clean) && !LANGUAGE_WORDS.has(clean);
  });
  return kept.length > 0 ? kept.join(' ') : query;
}

export function buildSearchQuery(rawQuery: string, mode: 'code' | 'repos' = 'code'): string {
  const query = rawQuery.trim();
  if (!query) return mode === 'repos' ? 'stars:>50 fork:false archived:false' : 'path:src/';

  if (/\b(repo|org|path|filename|language|stars|fork|symbol):/i.test(query)) return query;

  let language = '';
  if (/\b(typescript|ts)\b/i.test(query)) language = 'language:typescript';
  else if (/\b(javascript|js)\b/i.test(query)) language = 'language:javascript';
  else if (/\b(python|py)\b/i.test(query)) language = 'language:python';
  else if (/\b(rust|rs)\b/i.test(query)) language = 'language:rust';
  else if (/\b(golang|go)\b/i.test(query)) language = 'language:go';

  const parts = [searchTerms(query), language].filter(Boolean);
  if (mode === 'repos') {
    parts.push('fork:false', 'archived:false');
  } else {
    parts.push(
      'NOT path:test/',
      'NOT path:tests/',
      'NOT path:vendor/',
      'NOT path:node_modules/',
      'NOT path:dist/'
    );
  }
  return parts.join(' ');
}

/** Explicit global search is public-only even when the user credential can see more. */
export function buildPublicSearchQuery(rawQuery: string, mode: 'code' | 'repos' = 'code'): string {
  const built = buildSearchQuery(rawQuery, mode)
    .replace(/\bis:(?:public|private|internal)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${built} is:public`;
}

/**
 * Searches public repositories on GitHub.
 */
export async function searchGitHubRepos(
  request: GitHubRequest,
  query: string,
  limit = 10
): Promise<SearchResultSet> {
  const url = `/search/repositories?q=${encodeURIComponent(query)}&per_page=${Math.min(limit, 30)}&sort=stars&order=desc`;
  const response = await request(url);
  if (response.status !== 200) {
    return unavailableSearch('repository', response.status);
  }

  const body = response.json as {
    total_count?: number;
    items?: Array<Record<string, unknown>>;
    incomplete_results?: unknown;
  };
  const total = body?.total_count ?? 0;
  const rawItems = body?.items ?? [];
  const incomplete = body?.incomplete_results === true;

  // GitHub's own partial-answer flag. An empty partial answer is not a zero:
  // reporting it as one is the false absence this product must never produce.
  if (incomplete && rawItems.length === 0) {
    return {
      total: 0,
      items: [],
      unavailable:
        'GitHub repository search returned an incomplete index result and no matches, so no absence conclusion was made.'
    };
  }

  const items: SearchItem[] = rawItems.map((r) => {
    const repoFullName = String(r.full_name ?? '');
    const description = String(r.description ?? '');
    const stars = typeof r.stargazers_count === 'number' ? r.stargazers_count : 0;
    const url = String(r.html_url ?? `https://github.com/${repoFullName}`);
    return {
      id: repoFullName,
      title: repoFullName,
      repo: repoFullName,
      snippet: description,
      url,
      stars
    };
  });

  return { total, items, ...(incomplete ? { incomplete: true } : {}) };
}

/**
 * Searches public code across GitHub with text snippet matching.
 */

function selectBestCodeFragment(matches: Array<{ fragment?: string }> | undefined): string {
  if (!matches || matches.length === 0) return "";
  const scored = matches
    .map((m) => {
      const text = m.fragment?.trim() ?? "";
      let score = text.length;
      if (/^\s*(import|require|from)\b/m.test(text)) score -= 120;
      if (/\b(function|class|interface|type|const\s+[a-zA-Z0-9_]+\s*=|def\s+|async\s+)\b/.test(text)) score += 200;
      if (/\b(export\s+default|export\s+(async\s+)?function|export\s+const)\b/.test(text)) score += 300;
      return { text, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.text ?? "";
}

export async function searchGitHubCode(
  request: GitHubRequest,
  query: string,
  limit = 10
): Promise<SearchResultSet> {
  const url = `/search/code?q=${encodeURIComponent(query)}&per_page=${Math.min(limit, 25)}`;
  // Request text-match fragments so GitHub returns exact code context lines
  const response = await request(url, {
    accept: 'application/vnd.github.text-match+json'
  });

  if (response.status !== 200) {
    return unavailableSearch('code', response.status);
  }

  const body = response.json as {
    total_count?: number;
    items?: Array<{
      name?: string;
      path?: string;
      html_url?: string;
      repository?: { full_name?: string; description?: string };
      text_matches?: Array<{ fragment?: string }>;
    }>;
    incomplete_results?: unknown;
  };

  const total = body?.total_count ?? 0;
  const rawItems = body?.items ?? [];
  const incomplete = body?.incomplete_results === true;

  // An empty partial answer is not a zero. GitHub's code-search index can
  // answer 200 with `incomplete_results: true` and no items for code that
  // plainly exists, so it must never be read as "this code is not there".
  if (incomplete && rawItems.length === 0) {
    return {
      total: 0,
      items: [],
      unavailable:
        'GitHub code search returned an incomplete index result and no matches, so no absence conclusion was made.'
    };
  }

  const items: SearchItem[] = rawItems.map((item) => {
    const repo = String(item.repository?.full_name ?? '');
    const path = String(item.path ?? '');
    const title = `${repo}:${path}`;
    const fragment = selectBestCodeFragment(item.text_matches);
    const snippet = fragment.length > 0 ? fragment.slice(0, 300) : item.repository?.description ?? '';
    const url = item.html_url ?? `https://github.com/${repo}/blob/main/${path}`;

    return {
      id: `${repo}/${path}`,
      title,
      repo,
      path,
      snippet,
      url
    };
  });

  return { total, items, ...(incomplete ? { incomplete: true } : {}) };
}

// ---------------------------------------------------------------------------
// Committed content, read from the repository itself
// ---------------------------------------------------------------------------

/**
 * The one request that returns a repository's committed files is its archive.
 * GitHub's code-search index is a separate service that can answer 200 with
 * `incomplete_results: true` and no matches for code that is plainly there, so
 * repository-scoped search cannot depend on it alone. The archive is bounded
 * and read directly, which makes a literal search exact and complete up to the
 * stated limits — and honest when those limits are reached.
 */
// Deliberately well inside the isolate's memory: the compressed archive and
// its unpacked form are both resident while the scan runs, so the two caps are
// sized to leave room rather than to read the largest repository possible.
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 40 * 1024 * 1024;
const MAX_CONTENT_FILE_BYTES = 512 * 1024;
const MAX_SCANNED_FILES = 5000;
const MAX_MATCH_FILES = 50;
const MAX_CONTEXT_LINES = 5;

export interface CommittedTextHit {
  path: string;
  /** Total occurrences of every needle in this file. */
  count: number;
  /** How many of the distinct needles appear — how well a multi-word concept fits. */
  matched: number;
  /** Which needles appear, so a caller searching several can attribute each hit. */
  matchedNeedles: string[];
  lines: number[];
}

export interface CommittedTextSearch {
  hits: CommittedTextHit[];
  scanned: number;
  /** A bound was reached, so the search is not exhaustive and must not read as absence. */
  truncated: boolean;
  unavailable?: string;
}

export async function searchCommittedText(
  request: GitHubRequest,
  repo: RepoRef,
  ref: string,
  needles: string[],
  options: { caseSensitive?: boolean } = {}
): Promise<CommittedTextSearch> {
  const wanted = [...new Set(needles.map((needle) => needle.trim()).filter((needle) => needle.length > 0))];
  if (wanted.length === 0) return { hits: [], scanned: 0, truncated: false };

  let response: Awaited<ReturnType<GitHubRequest>>;
  try {
    response = await request(
      `/repos/${repo.owner}/${repo.name}/tarball/${ref.split('/').map(encodeURIComponent).join('/')}`,
      { raw: true, accept: 'application/vnd.github+json', maxBytes: MAX_ARCHIVE_BYTES }
    );
  } catch {
    return {
      hits: [],
      scanned: 0,
      truncated: false,
      unavailable: 'The committed-content archive could not be read, so no absence conclusion was made.'
    };
  }

  // 413 is the request layer refusing a body past the bound, not GitHub; both
  // mean the same thing here — too large to answer from, so not an absence.
  if (response.status === 413) {
    return {
      hits: [],
      scanned: 0,
      truncated: true,
      unavailable: 'This repository is too large for a bounded committed-content search. No absence conclusion was made.'
    };
  }
  if (response.status !== 200 || !response.bytes) {
    return {
      hits: [],
      scanned: 0,
      truncated: false,
      unavailable: `Committed-content search is unavailable (GitHub archive HTTP ${response.status}). No absence conclusion was made.`
    };
  }

  let tar: Uint8Array;
  try {
    const stream = new Blob([response.bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    tar = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return {
      hits: [],
      scanned: 0,
      truncated: false,
      unavailable: 'GitHub returned an unreadable repository archive. No absence conclusion was made.'
    };
  }
  if (tar.byteLength > MAX_UNPACKED_BYTES) {
    return {
      hits: [],
      scanned: 0,
      truncated: true,
      unavailable: 'This repository unpacks beyond the committed-content search bound. No absence conclusion was made.'
    };
  }

  const decoder = new TextDecoder('utf-8');
  const hits: CommittedTextHit[] = [];
  let scanned = 0;
  let truncated = false;
  let offset = 0;
  let pendingName: string | null = null;
  let terminated = false;

  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);

    // An archive ends with two zero blocks. A single zero block is padding and
    // is skipped rather than treated as the end.
    if (isZeroBlock(header)) {
      if (offset + 1024 <= tar.byteLength && isZeroBlock(tar.subarray(offset + 512, offset + 1024))) {
        terminated = true;
        break;
      }
      offset += 512;
      continue;
    }

    // A size Forge cannot read means the stream is no longer being walked from
    // a known point. Stop here rather than continue on a guessed offset, which
    // is how a parser starts reporting files that are not there.
    const size = readOctal(header, 124, 12);
    if (size === null || offset + 512 + size > tar.byteLength) {
      truncated = true;
      break;
    }

    const type = String.fromCharCode(header[156] ?? 48);
    const content = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    let name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    if (prefix && name) name = `${prefix}/${name}`;

    if (type === 'L') {
      // GNU long name: the next entry's name is this block's content.
      pendingName = readCString(content, 0, size);
      continue;
    }
    if (type === 'x' || type === 'g') {
      // PAX extended header: `path=` overrides the name of the next entry.
      const pax = paxPath(content, size);
      if (pax) pendingName = pax;
      continue;
    }
    if (pendingName !== null) {
      name = pendingName;
      pendingName = null;
    }
    if (!name || name.endsWith('/') || type === '5') continue;

    scanned += 1;
    if (scanned > MAX_SCANNED_FILES) {
      truncated = true;
      break;
    }
    // A file too large to read might contain a match, so skipping it makes the
    // result partial rather than empty.
    if (size > MAX_CONTENT_FILE_BYTES) {
      truncated = true;
      continue;
    }

    const body = content.subarray(0, size);
    if (size === 0 || body.includes(0)) continue;

    const text = decoder.decode(body);
    const lines: number[] = [];
    const matchedNeedles: string[] = [];
    let count = 0;
    for (const needle of wanted) {
      // A literal match, not a pattern: the needle is escaped, so a `.` or a
      // `(` in searched text is itself. Case-insensitive by default because a
      // concept search is a word search, not a case-sensitive identity check.
      const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.caseSensitive ? 'g' : 'gi');
      let present = false;
      for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        count += 1;
        present = true;
        if (lines.length < MAX_CONTEXT_LINES) lines.push(lineNumberAt(text, match.index));
        if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
      }
      if (present) matchedNeedles.push(needle);
    }
    if (count > 0) {
      hits.push({
        path: stripArchiveRoot(name),
        count,
        matched: matchedNeedles.length,
        matchedNeedles,
        lines
      });
      if (hits.length >= MAX_MATCH_FILES) {
        truncated = true;
        break;
      }
    }
  }

  // A body that stopped before the terminator is a truncated archive. Hits
  // found above it are real; calling the whole scan complete would not be.
  if (!terminated) truncated = true;
  if (!terminated && hits.length === 0) {
    return {
      hits: [],
      scanned,
      truncated: false,
      unavailable: 'GitHub returned a truncated repository archive. No absence conclusion was made.'
    };
  }

  return { hits, scanned, truncated };
}

function isZeroBlock(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

/** `null` when the field is not octal, which means the walk can no longer be trusted. */
function readOctal(bytes: Uint8Array, start: number, length: number): number | null {
  const raw = readCString(bytes, start, length).trim();
  if (!/^[0-7]*$/.test(raw)) return null;
  const value = Number.parseInt(raw || '0', 8);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function readCString(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  const body = end === -1 ? slice : slice.subarray(0, end);
  let out = '';
  for (const byte of body) out += String.fromCharCode(byte);
  return out.trim();
}

/** The `path=` record of a PAX extended header, if it carries one. */
function paxPath(content: Uint8Array, size: number): string | null {
  const text = new TextDecoder('utf-8').decode(content.subarray(0, size));
  for (const line of text.split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const record = line.slice(space + 1);
    if (record.startsWith('path=')) return record.slice('path='.length);
  }
  return null;
}

/** GitHub archives every file under `owner-repo-sha/`; a result is repo-relative. */
function stripArchiveRoot(name: string): string {
  const slash = name.indexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * Uses TypeSafe Jev System One to rank search candidates and identify the most
 * authoritative, production-grade implementation.
 */
export async function rankSearchResultsWithJev(
  env: Env | undefined,
  query: string,
  candidates: SearchItem[]
): Promise<SearchItem[]> {
  if (!env?.TYPESAFE_API_KEY || candidates.length <= 1) {
    return candidates;
  }

  const candidateSlice = candidates.slice(0, 15);
  const criteria = Object.fromEntries(
    candidateSlice.map((c) => [c.id, `${c.title} — ${c.snippet?.slice(0, 120) ?? ''}`])
  );

  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: {
      userQuery: query,
      candidates: candidateSlice.map((c) => ({
        id: c.id,
        title: c.title,
        repo: c.repo,
        snippet: c.snippet?.slice(0, 200),
        stars: c.stars
      }))
    },
    questions: {
      bestReference: {
        type: 'choice',
        instructions: `Which candidate is the highest quality, most production-ready implementation or authoritative documentation for: "${query}"?`,
        criteria
      },
      isUseful: {
        type: 'noul',
        instructions: `Does this candidate list contain at least one genuinely useful result for: "${query}"?`
      }
    }
  });

  if (!resp) return candidates;

  const bestChoice = resp.answers.bestReference;
  if (bestChoice?.type !== 'choice') return candidates;

  const usefulness = resp.answers.isUseful;
  const confidence = usefulness?.type === 'noul' ? usefulness.noul : 0.8;
  const ranked = [...candidates].sort(
    (left, right) => (bestChoice.distribution[right.id] ?? 0) - (bestChoice.distribution[left.id] ?? 0)
  );
  return ranked.map((item) => ({
    ...item,
    confidence,
    score: bestChoice.distribution[item.id] ?? 0
  }));
}
