/**
 * Zero-dependency TypeSafe Jev client for Cloudflare Workers.
 *
 * Jev is TypeSafe AI's System One decision engine. It evaluates state and typed
 * questions in ~70-200ms using a single non-autoregressive forward pass.
 *
 * Forge uses Jev only for bounded semantic decisions over GitHub evidence:
 * path/result ranking, excerpt selection, intent routing, change assessment,
 * capture-outline classification and safety predicates. Deterministic facts
 * remain GitHub's job; Jev may abstain without making a tool call fail.
 */
import type { Env } from './env';
import type { Comparison } from './contracts';

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
  const isCloudflare =
    endpoint.includes("cloudflare.com") ||
    endpoint.includes("/ai/run") ||
    apiKey.trim().startsWith("cfut_");

  // Choice criteria must be a map. Arrays 422 on the public API.
  const questions: Record<string, JevQuestion> = {};
  for (const [key, question] of Object.entries(payload.questions)) {
    if (question.type === "choice" && Array.isArray(question.criteria)) {
      questions[key] = {
        ...question,
        criteria: Object.fromEntries(question.criteria.map((item) => [String(item), String(item)]))
      };
    } else {
      questions[key] = question;
    }
  }

  const body = isCloudflare
    ? JSON.stringify({
        model: "typesafe/jev",
        input: {
          state: payload.state,
          questions
        }
      })
    : JSON.stringify({
        model: "jev-latest",
        state: payload.state,
        questions
      });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`
      },
      body,
      signal: controller.signal
    });

    if (!response.ok) return null;

    const data = (await response.json()) as any;
    if (!data || typeof data !== "object") return null;

    // Cloudflare returns { result: { result: { answers } } } or { result: { answers } }
    // Native TypeSafe returns { answers }
    const rawAnswers = data.result?.result?.answers ?? data.result?.answers ?? data.answers;
    if (!rawAnswers || typeof rawAnswers !== "object") return null;

    const answers: Record<string, JevAnswer> = {};
    for (const [k, v] of Object.entries(rawAnswers as Record<string, any>)) {
      if (!v || typeof v !== "object") continue;
      if (v.type === "choice" || v.choice !== undefined) {
        answers[k] = {
          type: "choice",
          choice: String(v.choice ?? ""),
          confidence: typeof v.confidence === "number" ? v.confidence : 0,
          distribution: v.distribution ?? v.probabilities ?? {}
        };
      } else if (v.type === "score" || v.score !== undefined) {
        answers[k] = {
          type: "score",
          score: typeof v.score === "number" ? v.score : 0,
          confidence: typeof v.confidence === "number" ? v.confidence : 0
        };
      } else {
        const noul = typeof v.noul === "number" ? v.noul : typeof v.probability === "number" ? v.probability : 0;
        answers[k] = { type: "noul", noul };
      }
    }

    return Object.keys(answers).length > 0 ? { answers } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface SemanticPathTriageResult {
  paths: string[];
  considered: number;
  total: number;
  truncated: boolean;
}

const MAX_SEMANTIC_PATHS = 5000;
const SEMANTIC_PATH_BATCH = 200;
const SEMANTIC_BATCH_FINALISTS = 5;

function representativePaths(paths: string[], query: string, limit: number): string[] {
  if (paths.length <= limit) return paths;
  const tokens = query.toLowerCase().match(/[a-z0-9_/-]{2,}/g) ?? [];
  const scored = paths
    .map((path) => ({
      path,
      score: tokens.reduce((sum, token) => sum + (path.toLowerCase().includes(token) ? 1 : 0), 0)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  const selected = new Set(scored.slice(0, Math.min(1000, limit)).map((entry) => entry.path));
  const remaining = paths.filter((path) => !selected.has(path));
  const slots = limit - selected.size;
  if (slots > 0 && remaining.length > 0) {
    for (let index = 0; index < slots; index += 1) {
      const at = Math.min(remaining.length - 1, Math.floor((index * remaining.length) / slots));
      selected.add(remaining[at]!);
    }
  }
  return [...selected].slice(0, limit);
}

async function rankPathBatch(
  env: Env,
  batch: string[],
  query: string
): Promise<Array<{ path: string; score: number }>> {
  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: { searchQuery: query, candidatePaths: batch },
    questions: {
      bestMatch: {
        type: 'choice',
        instructions: `Which file in 'candidatePaths' most directly implements, configures, or documents: "${query}"?`,
        criteria: batch
      },
      exists: {
        type: 'noul',
        instructions: `Does any path in candidatePaths actually implement or document: "${query}"? Answer no if the list is only weakly related.`
      }
    }
  });
  if (!resp) return [];
  const exists = noulOf(resp.answers.exists, 1);
  if (exists < 0.2) return [];
  const answer = resp.answers.bestMatch as JevChoiceAnswer | undefined;
  if (!answer) return [];

  const ranked = Object.entries(answer.distribution)
    .filter(([path, probability]) => batch.includes(path) && probability > 0.01)
    .sort((left, right) => right[1] - left[1])
    .slice(0, SEMANTIC_BATCH_FINALISTS)
    .map(([path, probability]) => ({ path, score: probability * exists }));
  if (ranked.length > 0) return ranked;
  return batch.includes(answer.choice) ? [{ path: answer.choice, score: exists }] : [];
}

/**
 * High-cardinality semantic path triage. Jev supports at most 255 choices, so
 * large repositories are reduced in parallel batches and then globally ranked
 * in a second Jev choice. A bounded representative sample protects latency on
 * enormous trees and the caller can disclose when that bound applied.
 */
export async function semanticPathTriageDetailed(
  env: Env,
  paths: string[],
  query: string
): Promise<SemanticPathTriageResult | null> {
  if (!env.TYPESAFE_API_KEY || paths.length === 0 || !query.trim()) return null;
  const candidates = representativePaths(paths, query.trim(), MAX_SEMANTIC_PATHS);
  const batches: string[][] = [];
  for (let index = 0; index < candidates.length; index += SEMANTIC_PATH_BATCH) {
    batches.push(candidates.slice(index, index + SEMANTIC_PATH_BATCH));
  }

  const batchResults = (await Promise.all(batches.map((batch) => rankPathBatch(env, batch, query.trim())))).flat();
  const bestByPath = new Map<string, number>();
  for (const candidate of batchResults) {
    bestByPath.set(candidate.path, Math.max(bestByPath.get(candidate.path) ?? 0, candidate.score));
  }
  const finalists = [...bestByPath.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 250)
    .map(([path, score]) => ({ path, score }));

  if (finalists.length === 0) {
    return { paths: [], considered: candidates.length, total: paths.length, truncated: candidates.length < paths.length };
  }
  if (finalists.length === 1) {
    return {
      paths: [finalists[0]!.path],
      considered: candidates.length,
      total: paths.length,
      truncated: candidates.length < paths.length
    };
  }

  const finalResp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: {
      searchQuery: query.trim(),
      finalists: finalists.map((candidate) => ({ path: candidate.path, preliminaryRelevance: candidate.score }))
    },
    questions: {
      bestMatch: {
        type: 'choice',
        instructions: `Rank the finalist paths by which most directly implements, configures, or documents: "${query.trim()}".`,
        criteria: Object.fromEntries(finalists.map((candidate) => [candidate.path, candidate.path]))
      },
      exists: {
        type: 'noul',
        instructions: `Does at least one finalist genuinely implement, configure, or document: "${query.trim()}"?`
      }
    }
  });

  let rankedPaths: string[] = [];
  if (finalResp && noulOf(finalResp.answers.exists, 1) >= 0.2) {
    const answer = finalResp.answers.bestMatch as JevChoiceAnswer | undefined;
    if (answer) {
      rankedPaths = Object.entries(answer.distribution)
        .filter(([path, probability]) => bestByPath.has(path) && probability > 0.02)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 20)
        .map(([path]) => path);
      if (rankedPaths.length === 0 && bestByPath.has(answer.choice)) rankedPaths = [answer.choice];
    }
  }
  if (rankedPaths.length === 0) rankedPaths = finalists.slice(0, 20).map((candidate) => candidate.path);

  return {
    paths: rankedPaths,
    considered: candidates.length,
    total: paths.length,
    truncated: candidates.length < paths.length
  };
}

/** Compatibility wrapper for callers that only need the ranked paths. */
export async function semanticPathTriage(env: Env, paths: string[], query: string): Promise<string[] | null> {
  const result = await semanticPathTriageDetailed(env, paths, query);
  return result && result.paths.length > 0 ? result.paths : null;
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

  // Create overlapping windows of 40 lines with 10 lines overlap. The preview
  // includes query-bearing lines plus first/middle/last context; using only the
  // first five lines made a 40-line section semantically invisible when the
  // implementation sat in its middle or tail.
  const windowSize = 40;
  const step = 30;
  const queryTokens = query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
  const chunks: Array<{ id: string; start: number; end: number; preview: string; lexicalScore: number }> = [];

  for (let i = 0; i < lines.length; i += step) {
    const start = i + 1;
    const end = Math.min(lines.length, i + windowSize);
    const chunkLines = lines.slice(i, end);
    const interesting = new Set<number>([0, 1, Math.floor(chunkLines.length / 2), chunkLines.length - 2, chunkLines.length - 1]);
    let lexicalScore = 0;
    for (let local = 0; local < chunkLines.length; local += 1) {
      const lower = (chunkLines[local] ?? '').toLowerCase();
      const hits = queryTokens.filter((token) => lower.includes(token)).length;
      if (hits > 0) {
        lexicalScore += hits;
        interesting.add(local);
        if (local > 0) interesting.add(local - 1);
        if (local + 1 < chunkLines.length) interesting.add(local + 1);
      }
    }
    const preview = [...interesting]
      .filter((local) => local >= 0 && local < chunkLines.length)
      .sort((left, right) => left - right)
      .slice(0, 12)
      .map((local) => `L${start + local}: ${(chunkLines[local] ?? '').slice(0, 220)}`)
      .join('\n');
    chunks.push({ id: `L${start}-L${end}`, start, end, preview, lexicalScore });
    if (end >= lines.length) break;
  }

  // Very long files are represented by the strongest lexical windows plus an
  // even sample across the whole file, so code near the end is not silently
  // excluded merely because it falls after the first 1,200 lines.
  let limitedChunks = chunks;
  if (chunks.length > 40) {
    const selected = new Map<string, (typeof chunks)[number]>();
    for (const chunk of [...chunks].sort((left, right) => right.lexicalScore - left.lexicalScore).slice(0, 20)) {
      if (chunk.lexicalScore > 0) selected.set(chunk.id, chunk);
    }
    const remainingSlots = 40 - selected.size;
    for (let index = 0; index < remainingSlots; index += 1) {
      const at = Math.min(chunks.length - 1, Math.floor((index * chunks.length) / Math.max(1, remainingSlots)));
      selected.set(chunks[at]!.id, chunks[at]!);
    }
    limitedChunks = [...selected.values()].sort((left, right) => left.start - right.start).slice(0, 40);
  }

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

export interface SeePointer {
  isErrorPage: boolean;
  /** Observed outline line Jev pointed at, or null when it abstains. */
  suspect: string | null;
  exists: number;
  next: 'read' | 'stop';
  pageType?: string;
  hasUnlabeledControls?: boolean;
}

const EXISTS_ACT = 0.35;
const ERROR_ACT = 0.8;

function noulOf(answer: JevAnswer | undefined, fallback: number): number {
  if (!answer || answer.type !== "noul") return fallback;
  return answer.noul;
}

/** Choice may return L4, l4, or the line text itself. */
export function lineFromChoice(choice: string | undefined, ids: string[], lines: string[]): string | null {
  if (!choice) return null;
  const idIndex = ids.indexOf(choice);
  if (idIndex >= 0) return lines[idIndex] ?? null;
  const textIndex = lines.indexOf(choice);
  if (textIndex >= 0) return lines[textIndex] ?? null;
  const numbered = /^L(\d+)$/i.exec(choice.trim());
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    return lines[index] ?? null;
  }
  return null;
}

/**
 * One fan-out over a capture outline. `next` is derived in code from exists/error.
 * Jev never sees the screenshot.
 */
export async function judgeSeePacket(
  env: Env,
  url: string,
  title: string,
  outline: string[]
): Promise<SeePointer | null> {
  if (!env.TYPESAFE_API_KEY || outline.length === 0) return null;

  const lines = outline.slice(0, 40);
  const ids = lines.map((_, index) => `L${index + 1}`);

  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: {
      url,
      title,
      lines: lines.map((text, index) => ({ id: ids[index], text }))
    },
    questions: {
      isError: {
        type: 'noul',
        instructions:
          'Does this outline represent an HTTP error, 404, 500, crash, login wall, or cookie/challenge page with no useful app UI?'
      },
      exists: {
        type: 'noul',
        instructions:
          'Does any line name a real control or landmark a person could use (nav, button, heading of the product), not only chrome or an error message?'
      },
      pageType: {
        type: 'choice',
        instructions: 'What category best describes this captured page UI?',
        criteria: ['landing', 'docs', 'dashboard', 'auth', 'form', 'settings', 'error', 'content']
      },
      hasUnlabeledControls: {
        type: 'noul',
        instructions: 'Are there buttons, links, or controls in this outline that lack descriptive names or text?'
      },
      suspect: {
        type: 'choice',
        instructions:
          'Which line id is the single most useful pointer for a developer fixing this page? Prefer a broken, unlabeled, or primary interactive control. If the page is an error, pick the error heading.',
        criteria: Object.fromEntries(ids.map((id, index) => [id, lines[index] ?? id]))
      }
    }
  });

  if (!resp) return null;

  const isError = noulOf(resp.answers.isError, 0);
  const exists = noulOf(resp.answers.exists, 0);
  const suspectChoice = (resp.answers.suspect as JevChoiceAnswer | undefined)?.choice;
  const suspect = lineFromChoice(suspectChoice, ids, lines);
  const isErrorPage = isError >= ERROR_ACT;
  const next: SeePointer['next'] = isErrorPage || exists < EXISTS_ACT ? 'stop' : 'read';

  const pageTypeAnswer = resp.answers.pageType as JevChoiceAnswer | undefined;
  const unlabeledAnswer = resp.answers.hasUnlabeledControls as JevNoulAnswer | undefined;
  const pageType = pageTypeAnswer?.choice;
  const hasUnlabeledControls = (unlabeledAnswer?.noul ?? 0) > 0.7;

  const result: SeePointer = {
    isErrorPage,
    suspect: exists < EXISTS_ACT && !isErrorPage ? null : suspect,
    exists,
    next
  };
  if (pageType && pageType !== 'generic') result.pageType = pageType;
  if (hasUnlabeledControls) result.hasUnlabeledControls = true;

  return result;
}

export interface ChangeAssessment {
  primaryArea: string;
  areaConfidence: number;
  intentMatch: number;
  breakingChange: number;
  securitySensitive: number;
  persistentDataChange: number;
  userVisible: number;
  testsRelevant: number;
  docsRelevant: number;
  multipleConcerns: number;
  outlierProbability: number;
  outlierPath: string | null;
}

/**
 * One Jev fan-out over a bounded diff. Each question is independent and narrow;
 * surrounding code decides which high-confidence signals deserve attention.
 * There is deliberately no aggregate "risk score".
 */
export async function assessChangeWithJev(
  env: Env,
  changeIntent: string,
  comparison: Comparison
): Promise<ChangeAssessment | null> {
  if (!env.TYPESAFE_API_KEY || comparison.files.length === 0) return null;
  const files = comparison.files.slice(0, 20).map((file) => ({
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: (file.patch ?? '').slice(0, 700)
  }));
  const filePaths = files.map((file) => file.path);
  const questions: Record<string, JevQuestion> = {
    primaryArea: {
      type: 'choice',
      instructions: 'What is the primary technical area changed by these files?',
      criteria: [
        'authentication/security',
        'api/integration',
        'ui/ux',
        'data/schema',
        'configuration/infrastructure',
        'dependencies',
        'testing',
        'documentation',
        'general code'
      ]
    },
    matchesIntent: {
      type: 'noul',
      instructions: `Do the changed files and patches substantially match the stated change intent: "${changeIntent}"? Answer no only for a meaningful scope mismatch.`
    },
    breakingChange: {
      type: 'noul',
      instructions: 'Does the diff appear to remove or incompatibly change a public API, persisted schema, protocol, configuration contract, or exported behavior?'
    },
    securitySensitive: {
      type: 'noul',
      instructions: 'Does the diff materially touch authentication, authorization, credentials, permissions, cryptography, request trust boundaries, or other security-sensitive behavior?'
    },
    persistentDataChange: {
      type: 'noul',
      instructions: 'Does the diff materially change persisted data shape, database schema, migrations, storage format, or data lifecycle behavior?'
    },
    userVisible: {
      type: 'noul',
      instructions: 'Is this change likely visible to an end user through UI, copy, API behavior, or externally observable product behavior?'
    },
    testsRelevant: {
      type: 'noul',
      instructions: 'Would automated tests plausibly be important evidence for this particular change, beyond trivial formatting or documentation-only edits?'
    },
    docsRelevant: {
      type: 'noul',
      instructions: 'Would user/developer documentation plausibly need updating because this change alters public behavior, configuration, setup, or an interface?'
    },
    multipleConcerns: {
      type: 'noul',
      instructions: 'Does this diff combine two or more substantially independent technical concerns that could reasonably be reviewed separately?'
    },
    hasOutlier: {
      type: 'noul',
      instructions: 'Is any changed file semantically out of scope relative to the stated intent and the rest of this diff?'
    }
  };
  if (filePaths.length > 1) {
    questions.outlierFile = {
      type: 'choice',
      instructions: 'Which changed file is the strongest scope outlier, if one exists?',
      criteria: filePaths
    };
  }

  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: {
      changeIntent,
      comparisonStatus: comparison.status,
      aheadBy: comparison.aheadBy,
      behindBy: comparison.behindBy,
      files
    },
    questions
  });
  if (!resp) return null;

  const area = resp.answers.primaryArea as JevChoiceAnswer | undefined;
  const outlier = resp.answers.outlierFile as JevChoiceAnswer | undefined;
  const outlierProbability = noulOf(resp.answers.hasOutlier, 0);
  return {
    primaryArea: area?.choice || 'general code',
    areaConfidence: area?.confidence ?? Math.max(0, ...Object.values(area?.distribution ?? {})),
    intentMatch: noulOf(resp.answers.matchesIntent, 0.5),
    breakingChange: noulOf(resp.answers.breakingChange, 0),
    securitySensitive: noulOf(resp.answers.securitySensitive, 0),
    persistentDataChange: noulOf(resp.answers.persistentDataChange, 0),
    userVisible: noulOf(resp.answers.userVisible, 0),
    testsRelevant: noulOf(resp.answers.testsRelevant, 0),
    docsRelevant: noulOf(resp.answers.docsRelevant, 0),
    multipleConcerns: noulOf(resp.answers.multipleConcerns, 0),
    outlierProbability,
    outlierPath: outlierProbability >= 0.7 && outlier?.choice && filePaths.includes(outlier.choice) ? outlier.choice : null
  };
}

export function summarizeChangeAssessment(assessment: ChangeAssessment, fileCount: number): string {
  const flags: string[] = [];
  if (assessment.securitySensitive >= 0.8) flags.push('security-sensitive');
  if (assessment.persistentDataChange >= 0.8) flags.push('persistent-data change');
  if (assessment.userVisible >= 0.8) flags.push('user-visible');
  if (assessment.breakingChange >= 0.85) flags.push('potentially breaking');
  if (assessment.multipleConcerns >= 0.85) flags.push('multiple concerns');
  const lead = assessment.primaryArea.charAt(0).toUpperCase() + assessment.primaryArea.slice(1);
  return `${lead}: ${fileCount} file${fileCount === 1 ? '' : 's'}${flags.length ? `; ${flags.join(', ')}` : ''}.`;
}

export function changeAssessmentNotices(assessment: ChangeAssessment, comparison: Comparison): string[] {
  const notices: string[] = [];
  const paths = comparison.files.map((file) => file.path.toLowerCase());
  const hasTests = paths.some((path) => /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)/.test(path) || /\.(test|spec)\.[^.]+$/.test(path));
  const hasDocs = paths.some((path) => path.startsWith('docs/') || /(^|\/)(readme|changelog)(\.|$)/.test(path) || /\.(md|mdx|rst)$/.test(path));

  if (assessment.intentMatch <= 0.2) notices.push('Jev notice: the diff appears weakly aligned with the change intent; inspect scope before merging.');
  if (assessment.securitySensitive >= 0.85) notices.push('Jev notice: this diff appears security-sensitive; give authentication, authorization, credential and trust-boundary changes extra review.');
  if (assessment.persistentDataChange >= 0.85) notices.push('Jev notice: this diff appears to change persistent data shape or lifecycle; migration/backward-compatibility evidence may matter.');
  if (assessment.breakingChange >= 0.85) notices.push('Jev notice: this diff appears potentially breaking for an API, schema, protocol, export, or configuration contract.');
  if (assessment.multipleConcerns >= 0.85) notices.push('Jev notice: this diff appears to combine multiple independent concerns; consider whether the review scope is broader than intended.');
  if (assessment.outlierProbability >= 0.8 && assessment.outlierPath) notices.push(`Jev notice: ${assessment.outlierPath} looks like a scope outlier relative to the rest of this change.`);
  if (assessment.testsRelevant >= 0.9 && !hasTests) notices.push('Jev notice: tests appear materially relevant, but no obvious test file is changed. This is advisory, not evidence that coverage is missing.');
  if (assessment.docsRelevant >= 0.92 && !hasDocs) notices.push('Jev notice: documentation appears relevant, but no obvious documentation file is changed. This is advisory, not evidence that documentation is missing.');
  return notices;
}

/**
 * Compatibility helper for callers that only need one concise impact sentence.
 */
export async function summarizeChangeImpactWithJev(
  env: Env,
  changeName: string,
  comparison: Comparison
): Promise<string | null> {
  if (!env.TYPESAFE_API_KEY || comparison.files.length === 0) return null;

  const assessment = await assessChangeWithJev(env, changeName, comparison);
  return assessment ? summarizeChangeAssessment(assessment, comparison.files.length) : null;
}

export interface ImpactIdentifierCandidate {
  identifier: string;
  occurrences: number;
  paths: string[];
}

export async function rankImpactIdentifiersWithJev(
  env: Env,
  changeIntent: string,
  candidates: ImpactIdentifierCandidate[]
): Promise<string[]> {
  if (!env.TYPESAFE_API_KEY || candidates.length === 0) {
    return candidates.slice(0, 5).map((candidate) => candidate.identifier);
  }
  const bounded = candidates.slice(0, 100);
  const identifiers = bounded.map((candidate) => candidate.identifier);
  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: { changeIntent, candidates: bounded },
    questions: {
      mostImpactful: {
        type: 'choice',
        instructions: 'Which removed or changed identifier is most likely to represent an externally meaningful code/API/config contract whose other repository occurrences are useful impact evidence?',
        criteria: identifiers
      },
      hasMeaningfulCandidate: {
        type: 'noul',
        instructions: 'Does at least one candidate look like a meaningful identifier or contract term worth searching elsewhere in the repository, rather than incidental syntax/local variable noise?'
      }
    }
  });
  if (!resp || noulOf(resp.answers.hasMeaningfulCandidate, 1) < 0.25) return [];
  const answer = resp.answers.mostImpactful as JevChoiceAnswer | undefined;
  if (!answer) return identifiers.slice(0, 5);
  const ranked = Object.entries(answer.distribution)
    .filter(([identifier, probability]) => identifiers.includes(identifier) && probability > 0.02)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([identifier]) => identifier);
  if (ranked.length > 0) return ranked;
  return identifiers.includes(answer.choice) ? [answer.choice] : identifiers.slice(0, 5);
}

export type ExactMatchKind =
  | 'declaration/definition'
  | 'code reference/call'
  | 'import/export'
  | 'configuration/serialized contract'
  | 'test/fixture/example'
  | 'documentation/prose'
  | 'generated/vendor'
  | 'unknown';

export interface ExactMatchClassification {
  id: string;
  kind: ExactMatchKind;
  confidence: number;
}

export async function classifyExactMatchContextsWithJev(
  env: Env,
  needle: string,
  contexts: Array<{ id: string; path: string; line: number; snippet: string }>
): Promise<ExactMatchClassification[]> {
  if (!env.TYPESAFE_API_KEY || contexts.length === 0) return [];
  const bounded = contexts.slice(0, 20);
  const kinds: ExactMatchKind[] = [
    'declaration/definition',
    'code reference/call',
    'import/export',
    'configuration/serialized contract',
    'test/fixture/example',
    'documentation/prose',
    'generated/vendor',
    'unknown'
  ];
  const questions: Record<string, JevQuestion> = {};
  for (const context of bounded) {
    questions[`match_${context.id}`] = {
      type: 'choice',
      instructions: `Classify the role of the exact text ${JSON.stringify(needle)} in match ${context.id}. Use only that match's path and local snippet from state.`,
      criteria: kinds
    };
  }
  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: {
      needle,
      matches: bounded
    },
    questions
  });
  if (!resp) return [];

  return bounded.map((context): ExactMatchClassification => {
    const answer = resp.answers[`match_${context.id}`] as JevChoiceAnswer | undefined;
    const kind = answer?.choice && kinds.includes(answer.choice as ExactMatchKind)
      ? answer.choice as ExactMatchKind
      : 'unknown';
    const confidence = answer?.confidence || Math.max(0, ...Object.values(answer?.distribution ?? {}));
    return { id: context.id, kind: confidence >= 0.4 ? kind : 'unknown', confidence };
  });
}

export type QualityGateKind = 'tests' | 'types' | 'lint/format' | 'security' | 'build' | 'deploy' | 'dependencies';

export interface QualityGateGuess {
  kind: QualityGateKind;
  path: string;
  confidence: number;
}

/**
 * Interpret committed configuration naming without claiming anything ran.
 * Each gate is an independent Choice over the same bounded candidate set, with
 * an explicit none option so Jev can abstain rather than force a match.
 */
export async function classifyQualityGatesWithJev(
  env: Env,
  files: Array<{ path: string; content: string }>
): Promise<QualityGateGuess[]> {
  if (!env.TYPESAFE_API_KEY || files.length === 0) return [];
  const candidates = files.slice(0, 16).map((file) => ({
    path: file.path,
    preview: file.content.slice(0, 1800)
  }));
  const paths = candidates.map((candidate) => candidate.path);
  const criteria = ['none', ...paths];
  const definitions: Array<[QualityGateKind, string]> = [
    ['tests', 'Which candidate most directly declares or runs automated tests? Choose none if no candidate does.'],
    ['types', 'Which candidate most directly declares or runs static type checking? Choose none if no candidate does.'],
    ['lint/format', 'Which candidate most directly declares or runs linting or formatting validation? Choose none if no candidate does.'],
    ['security', 'Which candidate most directly declares or runs security, secret, dependency-vulnerability, or static security analysis? Choose none if no candidate does.'],
    ['build', 'Which candidate most directly declares or runs a production/build/compile gate? Choose none if no candidate does.'],
    ['deploy', 'Which candidate most directly declares deployment or release automation? Choose none if no candidate does.'],
    ['dependencies', 'Which candidate most directly declares dependency update, lockfile, or dependency-health automation? Choose none if no candidate does.']
  ];
  const questions: Record<string, JevQuestion> = {};
  for (const [kind, instructions] of definitions) {
    questions[`gate_${kind.replace(/[^a-z]/g, '_')}`] = { type: 'choice', instructions, criteria };
  }
  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: { candidates },
    questions
  });
  if (!resp) return [];

  const results: QualityGateGuess[] = [];
  for (const [kind] of definitions) {
    const answer = resp.answers[`gate_${kind.replace(/[^a-z]/g, '_')}`] as JevChoiceAnswer | undefined;
    if (!answer || answer.choice === 'none' || !paths.includes(answer.choice)) continue;
    const confidence = answer.confidence || Math.max(0, ...Object.values(answer.distribution ?? {}));
    if (confidence < 0.45) continue;
    results.push({ kind, path: answer.choice, confidence });
  }
  return results;
}

export type ForgeReadEvidenceMode =
  | 'quality'
  | 'policy'
  | 'languages'
  | 'churn'
  | 'stats'
  | 'map'
  | 'history'
  | 'review'
  | 'impact'
  | 'dependencies';

export interface ForgeReadEvidenceRoute {
  mode: ForgeReadEvidenceMode;
  confidence: number;
}

/**
 * Route only questions that look like they are asking for a specialized
 * evidence source. Ordinary implementation/navigation questions skip this call
 * entirely and continue to semantic path/code search.
 */
export async function routeForgeReadEvidenceWithJev(
  env: Env,
  query: string,
  scope: 'repository' | 'change'
): Promise<ForgeReadEvidenceRoute | null> {
  if (!env.TYPESAFE_API_KEY || !query.trim()) return null;
  const trimmed = query.trim();
  const hints = scope === 'repository'
    ? /\b(test|tests|lint|format|typecheck|quality|ci|checks?|protect(?:ion)?|rules?|policy|languages?|stack|sizes?|large|big|structure|shape|history|recent|churn|hot|frequently changed)\b/i
    : /\b(review|merge|safe|safety|break|impact|references?|uses?|dependencies?|deps?|vulnerab|rules?|policy|checks?|sizes?|large|scope)\b/i;
  if (!hints.test(trimmed)) return null;

  const modes: ForgeReadEvidenceMode[] = scope === 'repository'
    ? ['quality', 'policy', 'languages', 'churn', 'stats', 'map', 'history']
    : ['review', 'impact', 'dependencies', 'policy', 'stats'];
  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: { query: trimmed, scope },
    questions: {
      evidenceMode: {
        type: 'choice',
        instructions: scope === 'repository'
          ? 'Which specialized evidence source best answers this repository question? quality=configured test/lint/type/build/security gates; policy=GitHub merge/branch rules; languages=language/stack distribution; churn=frequently changed files; stats=size/large files; map=repository structure; history=recent commits. Choose the closest only if the question primarily asks for that evidence.'
          : 'Which specialized evidence source best answers this change question? review=overall merge/review evidence; impact=what else may be affected or break; dependencies=dependency additions/removals/vulnerabilities; policy=GitHub merge rules; stats=change size/hotspots. Choose the closest only if the question primarily asks for that evidence.',
        criteria: modes
      },
      shouldRoute: {
        type: 'noul',
        instructions: 'Should this question be answered primarily from the specialized evidence mode rather than ordinary semantic code/file search?'
      }
    }
  });
  if (!resp || noulOf(resp.answers.shouldRoute, 0) < 0.72) return null;
  const answer = resp.answers.evidenceMode as JevChoiceAnswer | undefined;
  if (!answer?.choice || !modes.includes(answer.choice as ForgeReadEvidenceMode)) return null;
  const confidence = answer.confidence || Math.max(0, ...Object.values(answer.distribution ?? {}));
  if (confidence < 0.55) return null;
  return { mode: answer.choice as ForgeReadEvidenceMode, confidence };
}

export interface SearchIntentResult {
  intent: "docs" | "code" | "repos";
  platformId: string | null;
  language: string | null;
  coreQuery: string;
  isQuestionOrHowTo: boolean;
}

/**
 * Uses Jev System One to analyze natural query intent, identifying target platforms,
 * languages, and stripping conversational fluff in ~80ms.
 */
export async function analyzeSearchIntentWithJev(
  env: Env | undefined,
  query: string,
  supportedPlatformIds: string[]
): Promise<SearchIntentResult | null> {
  if (!env?.TYPESAFE_API_KEY || !query.trim()) return null;

  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: {
      query: query.trim(),
      platforms: supportedPlatformIds
    },
    questions: {
      intent: {
        type: "choice",
        instructions:
          "What is the user trying to find? \"docs\" for platform documentation, guides, or API specs; \"code\" for specific code snippets, implementations, or function examples; \"repos\" for libraries, starter templates, or full repositories.",
        criteria: ["docs", "code", "repos"]
      },
      platform: {
        type: "choice",
        instructions:
          "Which supported technology platform or framework is this query about, if any? Return \"none\" if no specific platform applies.",
        criteria: ["none", ...supportedPlatformIds]
      },
      language: {
        type: "choice",
        instructions:
          "What programming language is targeted by this query, if any? Return \"none\" if generic or unstated.",
        criteria: ["none", "typescript", "javascript", "python", "rust", "go", "html", "css", "sql"]
      },
      isQuestionOrHowTo: {
        type: "noul",
        instructions:
          "Is the user asking \"how to\", \"how do I\", or looking for documentation/configuration rather than searching for an exact code symbol?"
      }
    }
  });

  if (!resp) return null;

  const intentAnswer = resp.answers.intent as JevChoiceAnswer | undefined;
  const platformAnswer = resp.answers.platform as JevChoiceAnswer | undefined;
  const languageAnswer = resp.answers.language as JevChoiceAnswer | undefined;
  const isQuestionAnswer = resp.answers.isQuestionOrHowTo as JevNoulAnswer | undefined;

  const rawPlatform = platformAnswer?.choice;
  const platformId =
    rawPlatform && rawPlatform !== "none" && supportedPlatformIds.includes(rawPlatform)
      ? rawPlatform
      : null;

  const rawLang = languageAnswer?.choice;
  const language = rawLang && rawLang !== "none" ? rawLang : null;

  const isQuestionOrHowTo = (isQuestionAnswer?.noul ?? 0) > 0.6;
  const intent =
    (intentAnswer?.choice as "docs" | "code" | "repos") ??
    (isQuestionOrHowTo && platformId ? "docs" : "code");

  const cleaned = query
    .replace(
      /^(how\s+(do\s+i|to)|can\s+you\s+(find|show\s+me)|show\s+me|find\s+me|tell\s+me\s+about|what\s+is)\s+/i,
      ""
    )
    .trim();

  return {
    intent,
    platformId,
    language,
    coreQuery: cleaned || query.trim(),
    isQuestionOrHowTo
  };
}

/**
 * Analyzes changed files and diff to generate a concise, conventional commit message with Jev.
 */
export async function suggestCommitMessageWithJev(
  env: Env | undefined,
  files: Array<{ path: string; content?: string | null }>
): Promise<string | null> {
  if (!env?.TYPESAFE_API_KEY || files.length === 0) return null;

  const summaries = files.slice(0, 8).map((f) => ({
    path: f.path,
    preview: (f.content ?? "").slice(0, 400)
  }));

  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: { files: summaries },
    questions: {
      actionType: {
        type: "choice",
        instructions: "What is the primary conventional commit type for these file changes?",
        criteria: ["feat", "fix", "refactor", "docs", "chore", "test", "style"]
      },
      scope: {
        type: "choice",
        instructions: "What is the primary architectural component or directory affected?",
        criteria: ["auth", "api", "ui", "db", "config", "core", "search", "worker", "deps"]
      }
    }
  });

  if (!resp) return null;

  const action = (resp.answers.actionType as JevChoiceAnswer | undefined)?.choice ?? "chore";
  const scope = (resp.answers.scope as JevChoiceAnswer | undefined)?.choice ?? "core";
  const mainPath = files[0]?.path.split("/").pop() ?? "files";

  return `${action}(${scope}): update ${mainPath}`;
}

