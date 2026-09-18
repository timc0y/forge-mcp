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
