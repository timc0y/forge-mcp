import { classifyPath } from './paths';

/**
 * Bounded, deterministic repository-context selection. No embeddings, no
 * Vectorize, no model: files are ranked against the goal's tokens and the
 * task's likely paths. The client decides which files to actually read — this
 * never returns file contents.
 */

export type ContextCategory = 'source' | 'tests' | 'docs' | 'config';

export interface ContextQuery {
  goal: string;
  files: string[];
  likelyPaths?: string[];
  root?: string;
  maxResults?: number;
  categories?: ContextCategory[];
}

export interface ContextResult {
  path: string;
  reason: string;
  /** Governing instruction files (AGENTS.md/CLAUDE.md) up the directory tree. */
  instructions: string[];
  adjacentTests: string[];
  packageContext: string | null;
  warnings: string[];
  /** 0..1 relative confidence within this result set. */
  confidence: number;
}

export interface ContextResponse {
  schemaVersion: 1;
  goal: string;
  results: ContextResult[];
  /** True when maxResults clipped the ranking — nothing was silently dropped. */
  truncated: boolean;
  consideredFiles: number;
}

const INSTRUCTION_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'CODEX.md', '.cursorrules', '.geminirules']);
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'fix', 'add',
  'update', 'change', 'make', 'with', 'that', 'this', 'is', 'it', 'when', 'bug'
]);

function tokenize(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
  )];
}

function categoryOf(path: string): ContextCategory {
  const facts = classifyPath(path);
  if (facts.isTest) return 'tests';
  if (facts.isDoc) return 'docs';
  if (facts.isConfig || facts.isWorkerConfig || facts.isBuildTooling) return 'config';
  return 'source';
}

/** Instruction files whose directory is a prefix of the given path. */
function governingInstructions(path: string, instructionFiles: string[]): string[] {
  return instructionFiles
    .filter((instruction) => {
      const dir = instruction.includes('/') ? instruction.slice(0, instruction.lastIndexOf('/') + 1) : '';
      return path.startsWith(dir);
    })
    .sort((a, b) => a.length - b.length);
}

export function selectContext(query: ContextQuery): ContextResponse {
  const maxResults = Math.min(Math.max(query.maxResults ?? 12, 1), 100);
  const root = query.root ?? '';
  const tokens = tokenize(query.goal);
  const likely = new Set(query.likelyPaths ?? []);
  const instructionFiles = query.files.filter((f) => INSTRUCTION_NAMES.has(f.split('/').at(-1) ?? f));
  const testFiles = query.files.filter((f) => classifyPath(f).isTest);

  const candidates = query.files
    .filter((f) => (root ? f.startsWith(root.replace(/^\/+/, '')) || f.startsWith(root) : true))
    .filter((f) => !classifyPath(f).isGenerated)
    .filter((f) => !query.categories || query.categories.includes(categoryOf(f)));

  const scored = candidates.map((path) => {
    const lower = path.toLowerCase();
    const base = (path.split('/').at(-1) ?? path).toLowerCase();
    let score = 0;
    const reasons: string[] = [];

    if (likely.has(path)) {
      score += 10;
      reasons.push('named in the task likely paths');
    }
    let tokenHits = 0;
    for (const token of tokens) {
      if (base.includes(token)) {
        score += 3;
        tokenHits += 1;
      } else if (lower.includes(token)) {
        score += 1;
        tokenHits += 1;
      }
    }
    if (tokenHits > 0) reasons.push(`matches ${tokenHits} goal term(s)`);

    return { path, score, reasons };
  });

  const ranked = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const top = ranked.slice(0, maxResults);
  const maxScore = top[0]?.score ?? 1;

  const results: ContextResult[] = top.map((entry) => {
    const facts = classifyPath(entry.path);
    const stem = (entry.path.split('/').at(-1) ?? entry.path).replace(/\.[cm]?[jt]sx?$/, '');
    const adjacentTests = facts.isTest
      ? []
      : testFiles.filter((test) => test.includes(stem)).slice(0, 5);
    const warnings: string[] = [];
    if (facts.isConfig || facts.isWorkerConfig) warnings.push('configuration file — changes may need type regeneration');
    if (facts.isMigration) warnings.push('migration file — verify forward/backward safety');
    return {
      path: entry.path,
      reason: entry.reasons.join('; ') || 'path-similarity match',
      instructions: governingInstructions(entry.path, instructionFiles),
      adjacentTests,
      packageContext: facts.packageDir,
      warnings,
      confidence: Number((entry.score / maxScore).toFixed(2))
    };
  });

  return {
    schemaVersion: 1,
    goal: query.goal,
    results,
    truncated: ranked.length > maxResults,
    consideredFiles: candidates.length
  };
}
