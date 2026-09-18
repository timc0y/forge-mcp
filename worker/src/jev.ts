/**
 * Zero-dependency TypeSafe Jev client for Cloudflare Workers.
 *
 * Jev is TypeSafe AI's System One decision engine. It evaluates state and typed
 * questions in ~70-200ms using a single non-autoregressive forward pass.
 *
 * In Forge, Jev performs two tasks without storing repository copies:
 * 1. Semantic Path Triage: Given hundreds of raw repo file paths, score and rank
 *    which files implement or document a user's natural query.
 * 2. Token-Safe Excerpt Slicing: Given a large file and a query, pinpoint the
 *    exact line window implementing the concept so mobile ChatGPT isn't flooded
 *    with thousands of irrelevant tokens.
 */
import type { Env } from './env';

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string> | string[];
}

export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[] | number[];
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion;

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  distribution: Record<string, number>;
}

export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

export interface JevScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer;

export interface JevResponse {
  answers: Record<string, JevAnswer>;
}

export interface JevRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
}

const DEFAULT_JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_TIMEOUT_MS = 6000;

/**
 * Execute a TypeSafe System One evaluation.
 * Returns null on missing key, timeout, or network error so Forge degrades
 * gracefully to deterministic behavior.
 */
export async function typesafeSystemOne(
  apiKey: string | undefined,
  baseUrl: string | undefined,
  payload: JevRequest,
  timeoutMs = JEV_TIMEOUT_MS
): Promise<JevResponse | null> {
  if (!apiKey || apiKey.trim() === '') return null;

  const endpoint = baseUrl?.trim() ? baseUrl.trim() : DEFAULT_JEV_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) return null;

    const data = (await response.json()) as JevResponse;
    if (!data || typeof data !== 'object' || !data.answers) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Rank candidate paths by semantic relevance to a query in batches of up to 250.
 * Returns paths sorted by descending relevance probability.
 */
export async function semanticPathTriage(
  env: Env,
  paths: string[],
  query: string
): Promise<string[] | null> {
  if (!env.TYPESAFE_API_KEY || paths.length === 0 || !query.trim()) return null;

  // Jev choice supports up to 255 options. Take the first 250 candidate paths.
  // For larger repos, chunking into parallel batches is fast (<200ms).
  const batchSize = 250;
  const batches: string[][] = [];
  for (let i = 0; i < Math.min(paths.length, 750); i += batchSize) {
    batches.push(paths.slice(i, i + batchSize));
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
        state: {
          searchQuery: query,
          candidatePaths: batch
        },
        questions: {
          bestMatch: {
            type: 'choice',
            instructions: `Which file in 'candidatePaths' most directly implements, configures, or documents: "${query}"?`,
            criteria: batch
          }
        }
      });

      if (!resp) return [];

      const matchAnswer = resp.answers.bestMatch as JevChoiceAnswer | undefined;
      if (!matchAnswer || !matchAnswer.distribution) return [];

      return Object.entries(matchAnswer.distribution)
        .filter(([path, prob]) => batch.includes(path) && prob > 0.03)
        .sort((a, b) => b[1] - a[1])
        .map(([path]) => path);
    })
  );

  const flat = results.flat();
  return flat.length > 0 ? Array.from(new Set(flat)) : null;
}

export interface ExcerptResult {
  content: string;
  startLine: number;
  endLine: number;
  confidence: number;
}

/**
 * Slices a large file down to the relevant lines for a query using Jev.
 */
export async function semanticFileExcerpt(
  env: Env,
  path: string,
  fullContent: string,
  query: string
): Promise<ExcerptResult | null> {
  if (!env.TYPESAFE_API_KEY || !query.trim()) return null;

  const lines = fullContent.split('\n');
  if (lines.length <= 40) {
    return {
      content: fullContent,
      startLine: 1,
      endLine: lines.length,
      confidence: 1.0
    };
  }

  // Create overlapping windows of 40 lines with 10 lines overlap
  const windowSize = 40;
  const step = 30;
  const chunks: Array<{ id: string; start: number; end: number; preview: string }> = [];

  for (let i = 0; i < lines.length; i += step) {
    const start = i + 1;
    const end = Math.min(lines.length, i + windowSize);
    const chunkLines = lines.slice(i, end);
    const id = `L${start}-L${end}`;
    chunks.push({
      id,
      start,
      end,
      preview: chunkLines.slice(0, 5).join('\n')
    });
    if (end >= lines.length) break;
  }

  // Limit to 40 chunks max for prompt state limits
  const limitedChunks = chunks.slice(0, 40);

  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: {
      file: path,
      query,
      sections: limitedChunks.map((c) => ({ range: c.id, preview: c.preview }))
    },
    questions: {
      targetSection: {
        type: 'choice',
        instructions: `Which section in 'sections' contains the definition, logic, or answer for: "${query}"?`,
        criteria: limitedChunks.map((c) => c.id)
      },
      isRelevant: {
        type: 'noul',
        instructions: `Does this file actually contain the code or answer for: "${query}"?`
      }
    }
  });

  if (!resp) return null;

  const targetAnswer = resp.answers.targetSection as JevChoiceAnswer | undefined;
  const relevanceAnswer = resp.answers.isRelevant as JevNoulAnswer | undefined;

  const chosenId = targetAnswer?.choice;
  const confidence = relevanceAnswer?.noul ?? 0.5;

  if (!chosenId || confidence < 0.35) return null;

  const matched = limitedChunks.find((c) => c.id === chosenId);
  if (!matched) return null;

  const selectedText = lines.slice(matched.start - 1, matched.end).join('\n');
  return {
    content: selectedText,
    startLine: matched.start,
    endLine: matched.end,
    confidence
  };
}

/**
 * Uses Jev to choose the best matching repository from an account's repos
 * when given an informal, colloquial, or partial name.
 */
export async function resolveRepoWithJev(
  env: Env,
  query: string,
  availableRepos: Array<{ repo: string; description: string | null }>
): Promise<{ repo: string; confidence: number } | null> {
  if (!env.TYPESAFE_API_KEY || availableRepos.length === 0 || !query.trim()) return null;

  const repoNames = availableRepos.map((r) => r.repo);
  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: {
      userRepoQuery: query,
      repositories: availableRepos.slice(0, 50).map((r) => ({
        name: r.repo,
        description: r.description ?? ""
      }))
    },
    questions: {
      matchedRepo: {
        type: "choice",
        instructions: `Which repository in 'repositories' does the user mean by: "${query}"?`,
        criteria: repoNames.slice(0, 50)
      },
      confidence: {
        type: "noul",
        instructions: `How confident are you that this repository is the intended target for "${query}"?`
      }
    }
  });

  if (!resp) return null;

  const matchAnswer = resp.answers.matchedRepo as JevChoiceAnswer | undefined;
  const confAnswer = resp.answers.confidence as JevNoulAnswer | undefined;

  if (!matchAnswer?.choice) return null;

  return {
    repo: matchAnswer.choice,
    confidence: confAnswer?.noul ?? matchAnswer.confidence ?? 0.5
  };
}

/**
 * Fast regex patterns for high-severity credential leaks.
 */
const HIGH_SEVERITY_SECRET_PATTERNS = [
  /-----BEGIN [A-Z]+ PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9_]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/,
  /\bsk_live_[0-9a-zA-Z]{24,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*\b/
];

/**
 * Pre-commit security and integrity gate powered by pattern heuristics and Jev System One.
 */
export async function checkCommitSafety(
  env: Env | undefined,
  files: Array<{ path: string; content?: string | null }>
): Promise<{ safe: boolean; reason?: string }> {
  // 1. Fast static check (<1ms)
  for (const file of files) {
    if (!file.content) continue;
    for (const pattern of HIGH_SEVERITY_SECRET_PATTERNS) {
      if (pattern.test(file.content)) {
        return {
          safe: false,
          reason: `Commit rejected: ${file.path} contains what appears to be an unredacted secret token or private key.`
        };
      }
    }
  }

  // 2. If Jev is configured, check for subtle credential exposures and destructive truncations
  if (!env?.TYPESAFE_API_KEY) return { safe: true };

  const nonNullFiles = files.filter((f): f is { path: string; content: string } => typeof f.content === "string");
  if (nonNullFiles.length === 0) return { safe: true };

  const fileSummaries = nonNullFiles.slice(0, 5).map((f) => ({
    path: f.path,
    preview: f.content.slice(0, 2000),
    length: f.content.length
  }));

  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: { files: fileSummaries },
    questions: {
      hasSecretLeak: {
        type: "noul",
        instructions: "Do any of these code changes contain raw production API secrets, database passwords, or private tokens?"
      },
      isAccidentalTruncation: {
        type: "noul",
        instructions: "Does any file appear to be a broken, accidentally truncated snippet or an error trace committed in place of source code?"
      }
    }
  });

  if (!resp) return { safe: true };

  const secretLeak = resp.answers.hasSecretLeak as JevNoulAnswer | undefined;
  const truncated = resp.answers.isAccidentalTruncation as JevNoulAnswer | undefined;

  if (secretLeak && secretLeak.noul > 0.88) {
    return {
      safe: false,
      reason: "Commit rejected: Jev detected likely unredacted credentials or production API keys in the commit payload."
    };
  }

  if (truncated && truncated.noul > 0.92) {
    return {
      safe: false,
      reason: "Commit rejected: Jev detected that the commit payload appears to be truncated or contains an error message instead of valid code."
    };
  }

  return { safe: true };
}

/**
 * Ranks changed files in a pull request / change based on query relevance using Jev.
 */
export async function rankChangeFilesWithJev(
  env: Env,
  files: Array<{ path: string; patch?: string }>,
  query: string
): Promise<string[] | null> {
  if (!env.TYPESAFE_API_KEY || files.length === 0 || !query.trim()) return null;

  const fileEntries = files.slice(0, 30).map((f) => ({
    path: f.path,
    patchSnippet: (f.patch ?? "").slice(0, 500)
  }));

  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: {
      userQuery: query,
      changedFiles: fileEntries
    },
    questions: {
      relevantFiles: {
        type: "choice",
        instructions: `Which changed file in 'changedFiles' is most relevant to the query: "${query}"?`,
        criteria: fileEntries.map((f) => f.path)
      }
    }
  });

  if (!resp) return null;

  const answer = resp.answers.relevantFiles as JevChoiceAnswer | undefined;
  if (!answer?.distribution) {
    return answer?.choice ? [answer.choice] : null;
  }

  const sorted = Object.entries(answer.distribution)
    .filter(([_, score]) => score > 0.05)
    .sort((a, b) => b[1] - a[1])
    .map(([path]) => path);

  return sorted.length > 0 ? sorted : null;
}

/**
 * Analyzes an accessibility outline from forge_see to detect errors and provide a crisp summary.
 */
export async function analyzePageOutlineWithJev(
  env: Env,
  url: string,
  title: string,
  outline: string[]
): Promise<{ summary: string; isErrorPage: boolean } | null> {
  if (!env.TYPESAFE_API_KEY || outline.length === 0) return null;

  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: {
      url,
      title,
      pageOutline: outline.slice(0, 40)
    },
    questions: {
      isError: {
        type: "noul",
        instructions: "Does this page outline represent an HTTP error, 404 Not Found, 500 Internal Server Error, or crash page?"
      },
      pageCategory: {
        type: "choice",
        instructions: "What kind of web page is this?",
        criteria: [
          "marketing_landing",
          "documentation",
          "web_app_dashboard",
          "auth_login_form",
          "ecommerce_store",
          "error_maintenance"
        ]
      }
    }
  });

  if (!resp) return null;

  const isError = (resp.answers.isError as JevNoulAnswer | undefined)?.noul ?? 0;
  const category = (resp.answers.pageCategory as JevChoiceAnswer | undefined)?.choice ?? "web page";

  const categoryLabel = category.replace(/_/g, " ");
  const summary = isError > 0.8
    ? "Warning: Rendered outline appears to be an error or maintenance page."
    : `Detected as ${categoryLabel}.`;

  return {
    summary,
    isErrorPage: isError > 0.8
  };
}
