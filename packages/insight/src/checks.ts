import { classifyPath } from './paths';

/**
 * Deterministic, changed-path-based verification suggestions. Runs narrow to
 * broad: nothing here executes anything — the client decides what to run, and
 * Forge never silently runs an expensive command.
 */

export type CostClass = 'trivial' | 'cheap' | 'moderate' | 'expensive';

export interface CheckSuggestion {
  command: string;
  cwd: string;
  reason: string;
  costClass: CostClass;
  networkRequired: boolean;
  /** required = the change is unsafe to ship without it; optional = advisory. */
  required: boolean;
}

export interface SuggestChecksOptions {
  /** Monorepo-wide package manager; defaults to pnpm to match this repo. */
  packageManager?: 'pnpm' | 'npm' | 'yarn' | 'bun';
  repoRoot?: string;
}

const RANK: Record<CostClass, number> = { trivial: 0, cheap: 1, moderate: 2, expensive: 3 };

export function suggestChecks(paths: string[], options: SuggestChecksOptions = {}): CheckSuggestion[] {
  const pm = options.packageManager ?? 'pnpm';
  const root = options.repoRoot ?? '/workspace/repo';
  const facts = paths.map(classifyPath);

  const nonGenerated = facts.filter((f) => !f.isGenerated);
  const onlyDocs = nonGenerated.length > 0 && nonGenerated.every((f) => f.isDoc);

  // Documentation-only change: documentation checks only, nothing expensive.
  if (onlyDocs) {
    return [
      {
        command: `${pm} -w exec markdownlint-cli2 "**/*.md" || true`,
        cwd: root,
        reason: 'Documentation-only change; lint prose without building or testing.',
        costClass: 'cheap',
        networkRequired: false,
        required: false
      }
    ];
  }

  const suggestions: CheckSuggestion[] = [];
  const seen = new Set<string>();
  const add = (suggestion: CheckSuggestion) => {
    const key = `${suggestion.cwd}::${suggestion.command}`;
    if (!seen.has(key)) {
      seen.add(key);
      suggestions.push(suggestion);
    }
  };

  const packages = [...new Set(facts.map((f) => f.packageDir).filter((p): p is string => Boolean(p)))];
  for (const pkg of packages) {
    add({
      command: `${pm} --filter ./${pkg} typecheck`,
      cwd: root,
      reason: `Source changed in ${pkg}; typecheck the package before widening.`,
      costClass: 'cheap',
      networkRequired: false,
      required: true
    });
    add({
      command: `${pm} --filter ./${pkg} test`,
      cwd: root,
      reason: `Run ${pkg}'s own tests, the narrowest behavioural check.`,
      costClass: 'moderate',
      networkRequired: false,
      required: true
    });
  }

  if (facts.some((f) => f.isWorkerConfig)) {
    add({
      command: `${pm} cf:typegen`,
      cwd: root,
      reason: 'Worker configuration changed; regenerate binding types.',
      costClass: 'cheap',
      networkRequired: false,
      required: true
    });
    add({
      command: `${pm} exec wrangler deploy --dry-run`,
      cwd: root,
      reason: 'Validate the Worker configuration without deploying.',
      costClass: 'moderate',
      networkRequired: true,
      required: true
    });
  }

  if (facts.some((f) => f.isMigration)) {
    add({
      command: `${pm} schemas:check`,
      cwd: root,
      reason: 'Migration changed; confirm generated schemas stay consistent.',
      costClass: 'cheap',
      networkRequired: false,
      required: true
    });
  }

  if (facts.some((f) => f.isBuildTooling || f.isLockfile)) {
    add({
      command: `${pm} build`,
      cwd: root,
      reason: 'Build tooling or dependencies changed; a full build is warranted.',
      costClass: 'expensive',
      networkRequired: false,
      required: true
    });
  }

  // Fallback: touched source but matched no package (e.g. root-level source).
  if (suggestions.length === 0) {
    add({
      command: `${pm} typecheck`,
      cwd: root,
      reason: 'Source changed outside a known package; typecheck the workspace.',
      costClass: 'moderate',
      networkRequired: false,
      required: true
    });
  }

  return suggestions.sort((a, b) => RANK[a.costClass] - RANK[b.costClass]);
}
