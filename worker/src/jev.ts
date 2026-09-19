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

      const matchAnswer = resp.answers.bestMatch as JevChoiceAnswer | undefined;
      if (!matchAnswer) return [];

      const ranked = Object.entries(matchAnswer.distribution)
        .filter(([path, prob]) => batch.includes(path) && prob > 0.03)
        .sort((a, b) => b[1] - a[1])
        .map(([path]) => path);
      if (ranked.length > 0) return ranked;
      return batch.includes(matchAnswer.choice) ? [matchAnswer.choice] : [];
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

/**
 * Uses Jev to generate a concise, human-readable impact summary of a proposed merge/change.
 */
export async function summarizeChangeImpactWithJev(
  env: Env,
  changeName: string,
  comparison: Comparison
): Promise<string | null> {
  if (!env.TYPESAFE_API_KEY || comparison.files.length === 0) return null;

  const fileSnippets = comparison.files.slice(0, 15).map((f) => ({
    path: f.path,
    patch: (f.patch ?? "").slice(0, 300)
  }));

  const resp = await typesafeSystemOne(env.TYPESAFE_API_KEY, env.TYPESAFE_BASE_URL, {
    state: {
      changeName,
      status: comparison.status,
      files: fileSnippets
    },
    questions: {
      changeType: {
        type: "choice",
        instructions: "What is the primary technical category of this change?",
        criteria: ["feature", "bugfix", "refactor", "documentation", "configuration", "security"]
      },
      hasBreakingChange: {
        type: "noul",
        instructions: "Does this change appear to introduce breaking API changes, dropped schema columns, or removed public exports?"
      }
    }
  });

  if (!resp) return null;

  const type = (resp.answers.changeType as JevChoiceAnswer | undefined)?.choice ?? "update";
  const breaking = (resp.answers.hasBreakingChange as JevNoulAnswer | undefined)?.noul ?? 0;

  const warning = breaking > 0.85 ? " (⚠️ Caution: potentially breaking change)" : "";
  const fileSummary = `${comparison.files.length} file${comparison.files.length === 1 ? "" : "s"} modified`;

  return `${type.charAt(0).toUpperCase() + type.slice(1)}: ${fileSummary}${warning}.`;
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

/**
 * Deterministic post-commit advisory over the content GitHub actually stored.
 * It never gates a write: the caller invokes it only after the commit is durable.
 */
export async function lintCommittedFiles(
  files: Array<{ path: string; content?: string | null }>,
  knownRepoPaths: string[]
): Promise<string[]> {
  if (files.length === 0 || knownRepoPaths.length === 0) return [];

  const warnings: string[] = [];
  const knownSet = new Set(knownRepoPaths);

  const normalizeRelative = (fromPath: string, relative: string): string => {
    const parts = fromPath.split('/').slice(0, -1);
    for (const segment of relative.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') parts.pop();
      else parts.push(segment);
    }
    return parts.join('/');
  };

  for (const file of files) {
    if (!file.content) continue;
    const importMatches = file.content.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g);
    for (const match of importMatches) {
      const importPath = match[1];
      if (!importPath) continue;
      const normalized = normalizeRelative(file.path, importPath);
      const candidates = [
        normalized,
        `${normalized}.ts`,
        `${normalized}.tsx`,
        `${normalized}.js`,
        `${normalized}.jsx`,
        `${normalized}.mjs`,
        `${normalized}.cjs`,
        `${normalized}.json`,
        `${normalized}/index.ts`,
        `${normalized}/index.tsx`,
        `${normalized}/index.js`,
        `${normalized}/index.jsx`,
        `${normalized}/index.mjs`,
        `${normalized}/index.cjs`
      ];
      if (!candidates.some((candidate) => knownSet.has(candidate))) {
        warnings.push(
          `Post-commit notice: ${file.path} imports "${importPath}", but no matching committed file was found.`
        );
        break;
      }
    }
  }

  return warnings;
}
