import { ForgeError } from './errors';

export type Coverage = 'complete' | 'bounded' | 'unsupported' | 'unavailable';
export type EvidenceKind = 'source' | 'syntax' | 'github-check' | 'github-metadata' | 'jev-judgment';
export interface SourceIdentity {
  repo: string;
  requested: string;
  sha: string;
  private: boolean;
}
export interface SourceRange {
  /** JavaScript UTF-16 offsets, end exclusive. Never confuse these with UTF-8 bytes. */
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}
export interface Evidence {
  id: string;
  kind: EvidenceKind;
  source: SourceIdentity;
  path: string;
  range?: SourceRange;
  selector: string;
  text: string;
  representation: 'body' | 'outline' | 'record' | 'metadata';
  category: 'instruction' | 'implementation' | 'caller' | 'test' | 'configuration' | 'documentation' | 'check';
  coverage: Coverage;
  provenance: string;
  limitations: string[];
  mandatory?: boolean;
  relevance?: number;
  counterEvidence?: number;
}
export interface Relationship {
  kind: 'literal-import' | 'syntactic-call' | 'documentation-link' | 'compiler-reference';
  from: string;
  to: string;
  witness: string;
  resolved: boolean;
}
export const CONTEXT_LIMITS = Object.freeze({
  requestMs: 40_000,
  githubCalls: 64,
  concurrency: 4,
  parseBytes: 256 * 1024,
  sourceBytes: 1024 * 1024,
  retainedBytes: 2 * 1024 * 1024,
  outputBytes: 16 * 1024,
  maxOutputBytes: 32 * 1024,
  compressedBytes: 20 * 1024 * 1024,
  unpackedBytes: 40 * 1024 * 1024,
  jevStages: 3
});
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
export const estimatedTokens = (text: string): number => Math.ceil(utf8Bytes(text) / 4);
export const TOKEN_ESTIMATOR = 'utf8-bytes/4 estimate; not the host tokenizer';

export function requirePath(path: string): string {
  if (!path || path.includes('\\') || /[\u0000-\u001f]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Use an unambiguous repository-relative path.' });
  }
  return path;
}
export function requireSha(sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'An immutable source identity must be a full Git commit SHA.' });
  }
  return sha;
}
export function sourceRange(text: string, start: number, end: number): SourceRange {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length) {
    throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'The source range is invalid.' });
  }
  // A span must not split a UTF-16 surrogate pair.
  for (const offset of [start, end]) {
    if (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!)) {
      throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'The source range splits a Unicode character.' });
    }
  }
  return {
    start, end,
    startLine: text.slice(0, start).split('\n').length,
    endLine: text.slice(0, Math.max(start, end - 1)).split('\n').length
  };
}
export class RequestBudget {
  readonly started = Date.now();
  calls = 0;
  retained = 0;
  jevStages = 0;
  downloaded = 0;
  constructor(readonly milliseconds = CONTEXT_LIMITS.requestMs) {}
  remaining(): number { return Math.max(0, this.milliseconds - (Date.now() - this.started)); }
  assert(): void {
    if (!this.remaining()) this.exceeded('request deadline');
  }
  github(): void {
    this.assert();
    if (++this.calls > CONTEXT_LIMITS.githubCalls) this.exceeded('GitHub request count');
  }
  keep(bytes: number): void {
    this.assert();
    if (!Number.isSafeInteger(bytes) || bytes < 0) this.exceeded('invalid allocation');
    if (this.retained + bytes > CONTEXT_LIMITS.retainedBytes) this.exceeded('retained source bytes');
    this.retained += bytes;
  }
  semantic(): void {
    this.assert();
    if (++this.jevStages > CONTEXT_LIMITS.jevStages) this.exceeded('sequential JEV stages');
  }
  private exceeded(stage: string): never {
    throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: `Context request stopped at its ${stage} limit. Narrow the requested scope; no substitute result was used.` });
  }
}
export async function mapBounded<T, R>(items: readonly T[], run: (item: T, index: number) => Promise<R>, concurrency = CONTEXT_LIMITS.concurrency): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await run(items[index]!, index); }
      catch (error) { failed = true; failure = error; }
    }
  }));
  if (failed) throw failure;
  return results;
}
