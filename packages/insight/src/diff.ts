import { classifyPath, stableHash, type PathFacts } from './paths';

/**
 * Deterministic compact metadata for raw Git unified diffs. Syntax-only: no semantic certainty, no models. Serves as an index, not a substitute for inspecting raw diffs before mutation.
 */

export type FileChangeType = 'added' | 'deleted' | 'modified' | 'renamed';

export interface ChangedFile {
  path: string;
  changeType: FileChangeType;
  additions: number;
  deletions: number;
  facts: PathFacts;
  /** Exported/declared symbols touched on either side of the change. */
  changedSymbols: string[];
  /** True when an added line looks like a committed secret. */
  possibleSecret: boolean;
}

export interface CompactDiff {
  schemaVersion: 1;
  files: ChangedFile[];
  totalAdditions: number;
  totalDeletions: number;
  changedExports: string[];
  changedTests: string[];
  configChanges: string[];
  workerConfigChanges: string[];
  migrations: string[];
  lockfileChanges: string[];
  generatedChanges: string[];
  possibleSecretExposure: string[];
  riskAreas: string[];
  /** Suggested files to read first, ranked by change volume and risk. */
  suggestedHunks: string[];
  /** Stable hash of the analyzed diff. */
  hash: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /gh[posru]_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN[ A-Z]*PRIVATE KEY-----/,
  /\b[A-Za-z0-9._%+-]+:[^@\s/]{6,}@/,
  /\b(secret|token|api[_-]?key|password|passwd)\b\s*[:=]\s*['"][^'"]{8,}/i
];

// Syntax-only declaration shapes detectable from single added/removed lines.
const SYMBOL_PATTERNS: RegExp[] = [
  /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
  /(?:^|\s)class\s+([A-Za-z_$][\w$]*)/,
  /(?:def)\s+([A-Za-z_$][\w$]*)\s*\(/
];

function parseHeaderPath(line: string): string | null {
  // "diff --git a/foo b/bar" — prefer b/ (destination).
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (!match) return null;
  return match[2] ?? null;
}

function extractSymbols(line: string): string[] {
  const found: string[] = [];
  for (const pattern of SYMBOL_PATTERNS) {
    const match = pattern.exec(line);
    if (match?.[1]) found.push(match[1]);
  }
  return found;
}

export function analyzeDiff(diff: string): CompactDiff {
  const lines = diff.split('\n');
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;
  const symbolSet = new Set<string>();

  const flush = () => {
    if (current) {
      current.changedSymbols = [...new Set(current.changedSymbols)].sort();
      files.push(current);
    }
  };

  for (const line of lines) {
    const headerPath = parseHeaderPath(line);
    if (headerPath !== null) {
      flush();
      current = {
        path: headerPath,
        changeType: 'modified',
        additions: 0,
        deletions: 0,
        facts: classifyPath(headerPath),
        changedSymbols: [],
        possibleSecret: false
      };
      symbolSet.clear();
      continue;
    }
    if (!current) continue;

    if (line.startsWith('rename to ')) {
      current.changeType = 'renamed';
      current.path = line.slice('rename to '.length).trim();
      current.facts = classifyPath(current.path);
      continue;
    }
    if (line.startsWith('new file mode')) current.changeType = 'added';
    else if (line.startsWith('deleted file mode')) current.changeType = 'deleted';

    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) {
      current.additions += 1;
      const body = line.slice(1);
      if (SECRET_PATTERNS.some((pattern) => pattern.test(body))) current.possibleSecret = true;
      current.changedSymbols.push(...extractSymbols(body));
    } else if (line.startsWith('-')) {
      current.deletions += 1;
      current.changedSymbols.push(...extractSymbols(line.slice(1)));
    }
  }
  flush();

  const changedExports = [...new Set(files.flatMap((f) => f.changedSymbols))].sort();
  const riskAreas: string[] = [];
  if (files.some((f) => f.possibleSecret)) riskAreas.push('Possible secret in an added line — inspect before commit.');
  if (files.some((f) => f.facts.isMigration)) riskAreas.push('Database migration changed — verify forward/backward safety.');
  if (files.some((f) => f.facts.isWorkerConfig)) riskAreas.push('Worker configuration changed — regenerate types and validate Wrangler.');
  if (files.some((f) => f.facts.isGenerated)) riskAreas.push('Generated/build output changed — confirm it should be committed.');
  if (files.some((f) => f.facts.isBuildTooling)) riskAreas.push('Build tooling changed — a full build is warranted.');

  const suggestedHunks = [...files]
    .map((f) => ({
      path: f.path,
      weight: f.additions + f.deletions + (f.possibleSecret ? 1000 : 0) + (f.facts.isMigration ? 100 : 0)
    }))
    .sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path))
    .slice(0, 20)
    .map((f) => f.path);

  return {
    schemaVersion: 1,
    files,
    totalAdditions: files.reduce((sum, f) => sum + f.additions, 0),
    totalDeletions: files.reduce((sum, f) => sum + f.deletions, 0),
    changedExports,
    changedTests: files.filter((f) => f.facts.isTest).map((f) => f.path),
    configChanges: files.filter((f) => f.facts.isConfig).map((f) => f.path),
    workerConfigChanges: files.filter((f) => f.facts.isWorkerConfig).map((f) => f.path),
    migrations: files.filter((f) => f.facts.isMigration).map((f) => f.path),
    lockfileChanges: files.filter((f) => f.facts.isLockfile).map((f) => f.path),
    generatedChanges: files.filter((f) => f.facts.isGenerated).map((f) => f.path),
    possibleSecretExposure: files.filter((f) => f.possibleSecret).map((f) => f.path),
    riskAreas,
    suggestedHunks,
    hash: stableHash(diff)
  };
}
