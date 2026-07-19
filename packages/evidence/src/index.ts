/**
 * A clear, versioned evidence model. Evidence is portable JSON plus artifact
 * references — consumers never need to understand Cloudflare internals. Large
 * binary or textual payloads live as artifacts and are referenced by id.
 *
 * Functional evidence (structured application journeys) and browser evidence
 * (screenshots, accessibility) are deliberately distinct kinds: a screenshot
 * must never be represented as proof that a multi-step journey passed.
 */

export type EvidenceKind =
  | 'command_result'
  | 'test_result'
  | 'build_result'
  | 'screenshot'
  | 'accessibility_snapshot'
  | 'browser_journey'
  | 'structured_app_journey'
  | 'git_diff'
  | 'task_summary'
  | 'repository_identity'
  | 'commit_identity';

/** Explicit outcome states — success is never implied by absence of failure. */
export type EvidenceState = 'captured' | 'passed' | 'failed' | 'partial' | 'blocked' | 'unavailable';

export interface ArtifactReference {
  artifactId: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface Evidence {
  schemaVersion: 1;
  id: string;
  kind: EvidenceKind;
  state: EvidenceState;
  /** Small, safe, inline payload. Large data must be an artifact reference. */
  summary: Record<string, unknown>;
  artifacts: ArtifactReference[];
  repository?: { owner: string; name: string; commit?: string };
  /** Honest limitations; e.g. "screenshot only — interactions not executed". */
  limitations: string[];
  capturedAt: string;
  /** Deterministic content hash over the canonical evidence (excludes itself). */
  hash: string;
}

export interface EvidenceInput {
  id: string;
  kind: EvidenceKind;
  state: EvidenceState;
  summary: Record<string, unknown>;
  artifacts?: ArtifactReference[];
  repository?: Evidence['repository'];
  limitations?: string[];
  capturedAt: string;
}

/** Stable stringify with sorted keys so the hash is order-independent. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** FNV-1a over the canonical form; synchronous and dependency-free. */
export function evidenceHash(input: Omit<EvidenceInput, never>): string {
  const source = canonical({
    kind: input.kind,
    state: input.state,
    summary: input.summary,
    artifacts: input.artifacts ?? [],
    repository: input.repository,
    limitations: input.limitations ?? [],
    capturedAt: input.capturedAt
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const BROWSER_ONLY_KINDS = new Set<EvidenceKind>(['screenshot', 'accessibility_snapshot']);

export function createEvidence(input: EvidenceInput): Evidence {
  const limitations = [...(input.limitations ?? [])];
  // Guard the core honesty rule: static browser evidence is not journey proof.
  if (BROWSER_ONLY_KINDS.has(input.kind) && input.state === 'passed') {
    throw new Error('Screenshot/accessibility evidence cannot be marked "passed"; use "captured".');
  }
  if (BROWSER_ONLY_KINDS.has(input.kind)) {
    limitations.push('Static capture does not prove interactions that were not executed.');
  }
  return {
    schemaVersion: 1,
    id: input.id,
    kind: input.kind,
    state: input.state,
    summary: input.summary,
    artifacts: input.artifacts ?? [],
    ...(input.repository ? { repository: input.repository } : {}),
    limitations: [...new Set(limitations)],
    capturedAt: input.capturedAt,
    hash: evidenceHash(input)
  };
}

/** Verify an evidence record has not been tampered with since creation. */
export function verifyEvidence(evidence: Evidence): boolean {
  return evidence.hash === evidenceHash(evidence);
}
