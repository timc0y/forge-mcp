/**
 * Global GitHub search and authoritative platform documentation discovery.
 *
 * Provides:
 * 1. Curated mapping of major technical platforms to their open-source GitHub docs.
 * 2. High-precision Blackbird query synthesis (language, symbol, path, and anti-noise qualifiers).
 * 3. TypeSafe Jev System One candidate scoring to isolate production-grade references.
 */
import type { GitHubRequest, RepoRef } from './contracts';
import { formatRepo } from './contracts';
import type { Env } from './env';
import { typesafeSystemOne, type JevChoiceAnswer, type JevNoulAnswer } from './jev';

export interface DocPlatform {
  id: string;
  name: string;
  repo: RepoRef;
  docPathPrefix?: string;
  defaultBranch?: string;
  aliases: string[];
  description: string;
}

export const SUPPORTED_PLATFORMS: DocPlatform[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    repo: { owner: 'cloudflare', name: 'cloudflare-docs' },
    docPathPrefix: 'content',
    defaultBranch: 'production',
    aliases: ['cf', 'workers', 'pages', 'r2', 'd1', 'hyperdrive'],
    description: 'Cloudflare Workers, Pages, D1, KV, R2, and developer docs'
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    repo: { owner: 'vercel', name: 'next.js' },
    docPathPrefix: 'docs',
    defaultBranch: 'canary',
    aliases: ['next', 'vercel'],
    description: 'Next.js App Router, server components, and routing documentation'
  },
  {
    id: 'react',
    name: 'React',
    repo: { owner: 'reactjs', name: 'react.dev' },
    docPathPrefix: 'src/content',
    defaultBranch: 'main',
    aliases: ['reactjs', 'react-dom'],
    description: 'Official React documentation, hooks, and architecture guides'
  },
  {
    id: 'tailwind',
    name: 'Tailwind CSS',
    repo: { owner: 'tailwindlabs', name: 'tailwindcss.com' },
    docPathPrefix: 'src/pages/docs',
    defaultBranch: 'master',
    aliases: ['tailwindcss', 'tw'],
    description: 'Tailwind CSS utility classes, configuration, and plugins'
  },
  {
    id: 'mdn',
    name: 'MDN Web Docs',
    repo: { owner: 'mdn', name: 'content' },
    docPathPrefix: 'files/en-us',
    defaultBranch: 'main',
    aliases: ['webdocs', 'mozilla', 'html', 'css', 'javascript-api'],
    description: 'Web standards, JavaScript APIs, Web APIs, and CSS reference'
  },
  {
    id: 'hono',
    name: 'Hono',
    repo: { owner: 'honojs', name: 'website' },
    defaultBranch: 'main',
    aliases: ['honojs'],
    description: 'Fast, lightweight web framework for Cloudflare Workers, Node, and edge runtimes'
  },
  {
    id: 'mcp',
    name: 'Model Context Protocol',
    repo: { owner: 'modelcontextprotocol', name: 'specification' },
    defaultBranch: 'main',
    aliases: ['modelcontextprotocol', 'mcp-sdk'],
    description: 'Official Model Context Protocol specification, schema, and guidelines'
  },
  {
    id: 'bun',
    name: 'Bun',
    repo: { owner: 'oven-sh', name: 'bun' },
    docPathPrefix: 'docs',
    defaultBranch: 'main',
    aliases: ['oven', 'oven-sh'],
    description: 'Bun runtime documentation, package manager, and native APIs'
  },
  {
    id: 'supabase',
    name: 'Supabase',
    repo: { owner: 'supabase', name: 'supabase' },
    docPathPrefix: 'apps/docs',
    defaultBranch: 'master',
    aliases: ['supa', 'postgres'],
    description: 'Supabase database, auth, storage, and edge functions documentation'
  },
  {
    id: 'typescript',
    name: 'TypeScript',
    repo: { owner: 'microsoft', name: 'TypeScript-Website' },
    defaultBranch: 'v2',
    aliases: ['ts', 'tsc'],
    description: 'TypeScript handbook, compiler configuration, and language reference'
  },
  {
    id: 'typesafe',
    name: 'TypeSafe Jev',
    repo: { owner: 'typesafe-ai', name: 'typesafe' },
    defaultBranch: 'main',
    aliases: ['jev', 'systemone', 'system-one'],
    description: 'TypeSafe AI System One decision engine and API specification'
  },
  {
    id: 'webflow',
    name: 'Webflow',
    repo: { owner: 'webflow', name: 'developer-documentation' },
    defaultBranch: 'main',
    aliases: ['wf', 'webflow-api'],
    description: 'Webflow REST API, Apps, and Designer APIs documentation'
  },
  {
    id: 'astro',
    name: 'Astro',
    repo: { owner: 'withastro', name: 'docs' },
    docPathPrefix: 'src/content/docs',
    defaultBranch: 'main',
    aliases: ['withastro'],
    description: 'Astro web framework documentation, islands, and content collections'
  },
  {
    id: 'svelte',
    name: 'Svelte',
    repo: { owner: 'sveltejs', name: 'svelte' },
    docPathPrefix: 'documentation',
    defaultBranch: 'main',
    aliases: ['sveltejs', 'sveltekit'],
    description: 'Svelte and SvelteKit reactive framework documentation'
  },
  {
    id: 'vue',
    name: 'Vue.js',
    repo: { owner: 'vuejs', name: 'docs' },
    docPathPrefix: 'src',
    defaultBranch: 'main',
    aliases: ['vuejs'],
    description: 'Vue 3 composition API and component documentation'
  },
  {
    id: 'prisma',
    name: 'Prisma',
    repo: { owner: 'prisma', name: 'docs' },
    docPathPrefix: 'content',
    defaultBranch: 'main',
    aliases: ['prismadb', 'prisma-orm'],
    description: 'Prisma ORM, schema modeling, and database migration documentation'
  }
];

/**
 * Resolves a platform name or alias to a known documentation platform.
 */
export function resolveDocPlatform(rawInput: string): DocPlatform | null {
  const needle = rawInput.trim().toLowerCase();
  for (const platform of SUPPORTED_PLATFORMS) {
    if (platform.id === needle || platform.name.toLowerCase() === needle) {
      return platform;
    }
    if (platform.aliases.includes(needle)) {
      return platform;
    }
    const fullRepo = formatRepo(platform.repo).toLowerCase();
    if (fullRepo === needle || (platform.repo.name.toLowerCase() !== 'docs' && platform.repo.name.toLowerCase() === needle)) {
      return platform;
    }
  }
  return null;
}

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

export interface SearchResultOutcome {
  mode: 'code' | 'repos' | 'docs';
  queryUsed: string;
  totalFound: number;
  items: SearchItem[];
}

/**
 * Builds an advanced GitHub Blackbird search query from natural input.
 * Applies language detection, symbol qualifiers, and noise exclusion.
 */
export async function buildAdvancedSearchQuery(
  env: Env | undefined,
  rawQuery: string,
  mode: 'code' | 'repos' | 'docs' = 'code'
): Promise<{ query: string; detectedPlatform?: DocPlatform | null }> {
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return { query: mode === 'repos' ? 'stars:>50 fork:false' : 'path:src/ NOT path:test' };
  }

  // Check if query starts with platform or explicit target
  let detectedPlatform: DocPlatform | null = null;
  for (const platform of SUPPORTED_PLATFORMS) {
    const pattern = new RegExp(`\\b(${platform.id}|${platform.aliases.join('|')})\\b`, 'i');
    if (pattern.test(trimmed)) {
      detectedPlatform = platform;
      break;
    }
  }

  // If query already contains explicit GitHub qualifiers (e.g. path:, repo:, stars:), preserve directly
  const hasQualifiers = /\b(repo|org|path|filename|language|stars|fork|symbol):/i.test(trimmed);
  if (hasQualifiers) {
    return { query: trimmed, detectedPlatform };
  }

  // Fast language detection heuristics
  let languageQualifier = '';
  if (/\b(typescript|ts)\b/i.test(trimmed)) languageQualifier = 'language:typescript';
  else if (/\b(javascript|js)\b/i.test(trimmed)) languageQualifier = 'language:javascript';
  else if (/\b(python|py)\b/i.test(trimmed)) languageQualifier = 'language:python';
  else if (/\b(rust|rs)\b/i.test(trimmed)) languageQualifier = 'language:rust';
  else if (/\b(golang|go)\b/i.test(trimmed)) languageQualifier = 'language:go';

  // If mode is repos
  if (mode === 'repos') {
    const parts = [trimmed];
    if (languageQualifier) parts.push(languageQualifier);
    parts.push('fork:false');
    parts.push('archived:false');
    return { query: parts.join(' '), detectedPlatform };
  }

  // If mode is docs and a platform is detected
  if (mode === 'docs' && detectedPlatform) {
    const cleanTokens = trimmed
      .replace(new RegExp(`\\b(${detectedPlatform.id}|${detectedPlatform.aliases.join('|')})\\b`, 'gi'), '')
      .replace(/\b(docs|documentation|guide|reference)\b/gi, '')
      .trim();

    const parts = [`repo:${formatRepo(detectedPlatform.repo)}`];
    if (detectedPlatform.docPathPrefix) {
      parts.push(`path:${detectedPlatform.docPathPrefix}/`);
    }
    if (cleanTokens) {
      parts.push(cleanTokens);
    }
    return { query: parts.join(' '), detectedPlatform };
  }

  // Advanced code search with noise suppression
  const parts = [trimmed];
  if (languageQualifier) parts.push(languageQualifier);
  // Suppress test files, vendor dirs, and compiled code
  parts.push('NOT path:test/ NOT path:tests/ NOT path:vendor/ NOT path:node_modules/ NOT path:dist/');

  return { query: parts.join(' '), detectedPlatform };
}

/**
 * Searches public repositories on GitHub.
 */
export async function searchGitHubRepos(
  request: GitHubRequest,
  query: string,
  limit = 10
): Promise<{ total: number; items: SearchItem[] }> {
  const url = `/search/repositories?q=${encodeURIComponent(query)}&per_page=${Math.min(limit, 30)}&sort=stars&order=desc`;
  const response = await request(url);
  if (response.status !== 200) {
    return { total: 0, items: [] };
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
export async function searchGitHubCode(
  request: GitHubRequest,
  query: string,
  limit = 10
): Promise<{ total: number; items: SearchItem[] }> {
  const url = `/search/code?q=${encodeURIComponent(query)}&per_page=${Math.min(limit, 25)}`;
  // Request text-match fragments so GitHub returns exact code context lines
  const response = await request(url, {
    accept: 'application/vnd.github.text-match+json'
  });

  if (response.status !== 200) {
    return { total: 0, items: [] };
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
    const fragment = item.text_matches?.[0]?.fragment?.trim() ?? '';
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
      isQuality: {
        type: 'noul',
        instructions: `Does candidate list contain high-quality, practical code or documentation for: "${query}"?`
      }
    }
  });

  if (!resp) return candidates;

  const bestChoice = resp.answers.bestReference as JevChoiceAnswer | undefined;
  const qualityNoul = resp.answers.isQuality as JevNoulAnswer | undefined;

  if (bestChoice?.distribution) {
    const dist = bestChoice.distribution;
    const ranked = [...candidates].sort((a, b) => (dist[b.id] ?? 0) - (dist[a.id] ?? 0));
    return ranked.map((item) => ({
      ...item,
      confidence: qualityNoul?.noul ?? 0.8,
      score: dist[item.id] ?? 0
    }));
  }

  return candidates;
}
