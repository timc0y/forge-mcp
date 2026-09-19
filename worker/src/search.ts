/**
 * Small GitHub search helpers. GitHub is the index; Jev only ranks the bounded
 * results GitHub returns.
 */
import type { GitHubRequest } from './contracts';
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

  const parts = [query, language].filter(Boolean);
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

  const body = response.json as { total_count?: number; items?: Array<Record<string, unknown>> };
  const total = body?.total_count ?? 0;
  const rawItems = body?.items ?? [];

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

  return { total, items };
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
  };

  const total = body?.total_count ?? 0;
  const rawItems = body?.items ?? [];

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

  return { total, items };
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
