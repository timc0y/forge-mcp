/**
 * Deterministic intelligence over repository state GitHub already owns.
 *
 * Nothing here executes repository code, stores an index, or depends on Jev.
 * These helpers make trees, diffs and committed text easier to reason about
 * while keeping GitHub as the only source of truth.
 */
import type { ChangedFile } from './contracts';

export interface RepositoryTreeEntry {
  path: string;
  type: 'file' | 'dir';
  size: number;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export function isStatsQuery(query: string): boolean {
  const value = query.trim();
  return (
    /^stats?(?:\s|:|$)/i.test(value) ||
    /^(?:sizes?|repo(?:sitory)? stats?|code size|folder sizes?|largest files?)$/i.test(value)
  );
}

export function statsScope(query: string): string | null {
  const match = /^stats?(?:\s+|:\s*)(.+)$/i.exec(query.trim());
  const scope = match?.[1]?.trim().replace(/^\/+|\/+$/g, '');
  return scope ? scope : null;
}

export function isMapQuery(query: string): boolean {
  return /^(?:map|repo map|repository map|repo structure|repository structure)$/i.test(query.trim());
}

export function exactFindNeedle(query: string): string | null {
  const match = /^(?:find(?: all)?|text):\s*(.+)$/i.exec(query.trim());
  const needle = match?.[1]?.trim();
  return needle ? needle : null;
}

export function semanticCodeNeedle(query: string): string | null {
  const match = /^code:\s*(.+)$/i.exec(query.trim());
  const needle = match?.[1]?.trim();
  return needle ? needle : null;
}

export function isDependencyQuery(query: string): boolean {
  return /^(?:deps?|dependencies|dependency review|dependency changes|vulnerabilities)$/i.test(query.trim());
}

export function isReviewQuery(query: string): boolean {
  return /^(?:review|review change|change review|review packet|merge review)$/i.test(query.trim());
}

export function isImpactQuery(query: string): boolean {
  return /^(?:impact|impact analysis|what uses this|what could break|references affected)$/i.test(query.trim());
}

export function isPolicyQuery(query: string): boolean {
  return /^(?:policy|rules|ruleset|rulesets|branch protection|required checks)$/i.test(query.trim());
}

export function historyScope(query: string): string | null | undefined {
  const trimmed = query.trim();
  if (!/^history(?:\s|:|$)/i.test(trimmed)) return undefined;
  const match = /^history(?:\s+|:\s*)(.*)$/i.exec(trimmed);
  const scope = match?.[1]?.trim().replace(/^\/+|\/+$/g, '');
  return scope ? scope : null;
}

export function isLanguagesQuery(query: string): boolean {
  return /^(?:languages?|language stats?|tech stack|stack)$/i.test(query.trim());
}

export function isChurnQuery(query: string): boolean {
  return /^(?:churn|hot files?|hotspots?|recent churn|frequently changed)$/i.test(query.trim());
}

export function isQualityQuery(query: string): boolean {
  return /^(?:quality|quality gates?|gates?|ci|checks configured|repo checks|validation)$/i.test(query.trim());
}

export function isHygieneQuery(query: string): boolean {
  return /^(?:hygiene|code hygiene|repo hygiene|legacy(?: code)?|dead(?: code)?|fallback(?: code)?|obsolete(?: code)?|deprecated(?: code)?|broken(?: code)?|unused(?: code)?|find (?:legacy|dead|fallback|obsolete|deprecated|broken|unused)(?: code)?|find fallbacks?|cleanup candidates?)$/i.test(query.trim());
}

export function isMigrationQuery(query: string): boolean {
  return /^(?:migrations?|migration history|migration safety|migration check|migration checks|migration ordering|migration order|schema migrations?)$/i.test(query.trim());
}

export interface MigrationHistoryEvidence {
  files: number;
  issues: number;
  lines: string[];
}

/**
 * Deterministic structure checks for the common D1-style numbered SQL migration
 * layout. Duplicate/missing prefixes are evidence to inspect, not proof a
 * deployment is unsafe: repositories may deliberately carry a historical
 * exception and encode that policy in a committed verifier.
 */
export function migrationHistoryEvidence(entries: RepositoryTreeEntry[]): MigrationHistoryEvidence {
  const files = entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => entry.path);
  const migrations = files.flatMap((path) => {
    const match = /^(.*(?:^|\/)migrations)\/(\d{4})[_-][^/]+\.sql$/i.exec(path);
    if (!match?.[1] || !match[2]) return [];
    return [{ path, directory: match[1], prefix: match[2], number: Number(match[2]) }];
  });
  const checkers = files
    .filter((path) => /(?:migration.*(?:check|verify)|(?:check|verify).*migration)/i.test(path))
    .slice(0, 8);
  const byDirectory = new Map<string, typeof migrations>();
  for (const migration of migrations) {
    const group = byDirectory.get(migration.directory) ?? [];
    group.push(migration);
    byDirectory.set(migration.directory, group);
  }

  const lines: string[] = [];
  let issues = 0;
  for (const [directory, group] of [...byDirectory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...group].sort((left, right) => left.number - right.number || left.path.localeCompare(right.path));
    const prefixes = new Map<string, string[]>();
    for (const migration of sorted) {
      const paths = prefixes.get(migration.prefix) ?? [];
      paths.push(migration.path);
      prefixes.set(migration.prefix, paths);
    }

    const min = sorted[0]?.prefix ?? 'unknown';
    const max = sorted.at(-1)?.prefix ?? 'unknown';
    lines.push(`MIGRATIONS ${directory}/ · ${sorted.length} files · prefixes ${min}–${max}`);

    for (const [prefix, paths] of prefixes) {
      if (paths.length < 2) continue;
      issues += 1;
      lines.push(`DUPLICATE? ${directory}/ · prefix ${prefix} · ${paths.join(', ')}`);
    }

    const numbers = new Set(sorted.map((migration) => migration.number));
    const highest = Math.max(0, ...numbers);
    if (numbers.has(1) && highest <= 9999) {
      const missing: string[] = [];
      for (let number = 1; number <= highest; number += 1) {
        if (!numbers.has(number)) missing.push(String(number).padStart(4, '0'));
        if (missing.length >= 20) break;
      }
      if (missing.length > 0) {
        issues += missing.length;
        lines.push(`MISSING? ${directory}/ · ${missing.join(', ')}${missing.length >= 20 ? ' …' : ''}`);
      }
    }
  }

  for (const checker of checkers) lines.push(`CHECKER ${checker}`);
  if (migrations.length === 0) lines.push('No numbered SQL migration files were found under a migrations/ directory.');

  return { files: migrations.length, issues, lines };
}

const HYGIENE_SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|astro|liquid|vue|svelte|html?|css|scss|less|sql|graphql|gql|ya?ml|toml|jsonc?|py|rb|php|go|rs|java|kt|kts|swift|cs|fs|fsx|scala|c|cc|cpp|cxx|h|hh|hpp)$/i;
const HYGIENE_IGNORED_PATH = /(^|\/)(?:node_modules|vendor|dist|build|coverage|\.next|\.nuxt|target|Pods|DerivedData|generated|__generated__)(\/|$)/i;

export function isHygieneSourcePath(path: string): boolean {
  return HYGIENE_SOURCE_EXTENSION.test(path) && !HYGIENE_IGNORED_PATH.test(path) && !isDocumentationLikePath(path);
}

export interface HygienePathCandidate {
  path: string;
  signals: string[];
  score: number;
}

/**
 * Cheap path-only hygiene signals. These are candidate generators, never proof
 * that a file is unused or safe to delete.
 */
export function hygienePathCandidates(
  entries: RepositoryTreeEntry[],
  limit = 24
): HygienePathCandidate[] {
  const candidates: HygienePathCandidate[] = [];
  for (const entry of entries) {
    if (entry.type !== 'file' || !isHygieneSourcePath(entry.path)) continue;
    const lower = entry.path.toLowerCase();
    const signals: string[] = [];
    let score = 0;
    const add = (signal: string, weight: number) => {
      if (!signals.includes(signal)) signals.push(signal);
      score += weight;
    };
    if (/(^|[\/_.-])legacy([\/_.-]|$)/.test(lower)) add('legacy path/name', 7);
    if (/(^|[\/_.-])deprecated([\/_.-]|$)/.test(lower)) add('deprecated path/name', 7);
    if (/(^|[\/_.-])fallback([\/_.-]|$)/.test(lower)) add('fallback path/name', 6);
    if (/(^|[\/_.-])compat(?:ibility)?([\/_.-]|$)/.test(lower)) add('compatibility path/name', 5);
    if (/(^|[\/_.-])(?:obsolete|unused|dead)([\/_.-]|$)/.test(lower)) add('obsolete/unused path/name', 6);
    if (/(^|[\/_.-])(?:old|previous|backup|bak|tmp|temp)([\/_.-]|$)/.test(lower)) add('old/temporary path/name', 4);
    if (/(^|[\/_.-])v(?:0|1)([\/_.-]|$)/.test(lower)) add('early-version path/name', 2);
    if (score > 0) candidates.push({ path: entry.path, signals, score });
  }
  return candidates
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit);
}

const HYGIENE_CONTENT_MARKER = /\b(?:legacy|deprecated|retired|fallback|compat(?:ibility)?|obsolete|temporary|workaround|backward(?:s)?[- ]compat(?:ible|ibility)?|dead code|unused)\b|\bremove\s+(?:after|when|once)\b|\bTODO\b.{0,80}\bremove\b/i;

/**
 * Keep marker-bearing neighborhoods plus representative file context. This is
 * more informative to Jev than blindly taking the first N characters.
 */
export function queryContentPreview(content: string, query: string, maxChars = 4500): string {
  if (content.length <= maxChars) return content;

  const lines = content.split('\n');
  const tokens = [...new Set(query.toLowerCase().match(/[a-z0-9_/-]{3,}/g) ?? [])];
  const selected = new Set<number>([0, 1, lines.length - 2, lines.length - 1]);

  for (let index = 0; index < lines.length; index += 1) {
    const lower = (lines[index] ?? '').toLowerCase();
    if (!tokens.some((token) => lower.includes(token))) continue;
    for (let around = Math.max(0, index - 1); around <= Math.min(lines.length - 1, index + 1); around += 1) {
      selected.add(around);
    }
    if (selected.size >= 32) break;
  }

  if (selected.size < 12) {
    const slots = 12 - selected.size;
    for (let index = 0; index < slots; index += 1) {
      selected.add(Math.min(lines.length - 1, Math.floor((index * lines.length) / Math.max(1, slots))));
    }
  }

  return [...selected]
    .filter((index) => index >= 0 && index < lines.length)
    .sort((left, right) => left - right)
    .map((index) => `L${index + 1}: ${lines[index] ?? ''}`)
    .join('\n')
    .slice(0, maxChars);
}

export function hygieneContentPreview(content: string, maxChars = 3200): string {
  const lines = content.split('\n');
  if (content.length <= maxChars) return content;
  const selected = new Set<number>();
  for (let index = 0; index < Math.min(8, lines.length); index += 1) selected.add(index);
  for (let index = Math.max(0, lines.length - 4); index < lines.length; index += 1) selected.add(index);
  for (let index = 0; index < lines.length; index += 1) {
    if (!HYGIENE_CONTENT_MARKER.test(lines[index] ?? '')) continue;
    for (let around = Math.max(0, index - 2); around <= Math.min(lines.length - 1, index + 2); around += 1) {
      selected.add(around);
    }
    if (selected.size >= 36) break;
  }
  const rendered = [...selected]
    .sort((left, right) => left - right)
    .map((index) => `L${index + 1}: ${lines[index] ?? ''}`)
    .join('\n');
  return rendered.slice(0, maxChars);
}

const HYGIENE_GENERIC_IDENTIFIERS = new Set([
  'main', 'index', 'handler', 'config', 'options', 'result', 'request', 'response',
  'error', 'data', 'value', 'state', 'client', 'server', 'app', 'default'
]);

/**
 * One search anchor for bounded reference evidence. It deliberately prefers a
 * named public/exported symbol and falls back to a distinctive file stem.
 */
export function hygieneReferenceTerm(path: string, content: string): string | null {
  const terms = new Set<string>();
  const patterns = [
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][\w]*)/gm,
    /^\s*(?:func|type)\s+([A-Za-z_][\w]*)/gm
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const term = match[1];
      if (term && term.length >= 4 && !HYGIENE_GENERIC_IDENTIFIERS.has(term.toLowerCase())) terms.add(term);
      if (terms.size >= 12) break;
    }
  }
  const ranked = [...terms].sort((left, right) => right.length - left.length || left.localeCompare(right));
  if (ranked[0]) return ranked[0];

  const name = (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
  const normalized = name.replace(/[^A-Za-z0-9_$]/g, '');
  return normalized.length >= 5 && !HYGIENE_GENERIC_IDENTIFIERS.has(normalized.toLowerCase()) ? normalized : null;
}

export function isDocumentationLikePath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.startsWith('docs/') ||
    /(^|\/)(readme|changelog|contributing)(\.|$)/.test(lower) ||
    /\.(?:md|mdx|rst|adoc)$/.test(lower)
  );
}

export function qualityCandidatePaths(entries: RepositoryTreeEntry[], limit = 16): string[] {
  const files = entries.filter((entry) => entry.type === 'file').map((entry) => entry.path);
  const priority = (path: string): number => {
    const lower = path.toLowerCase();
    const name = lower.split('/').pop() ?? lower;
    if (lower.startsWith('.github/workflows/') && /\.ya?ml$/.test(lower)) return 0;
    if (name === 'package.json') return 1;
    if (
      /^(?:makefile|justfile|pyproject\.toml|tox\.ini|pytest\.ini|cargo\.toml|go\.mod|biome\.jsonc?|eslint\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|ruff\.toml|\.pre-commit-config\.ya?ml|dependabot\.ya?ml|codeql-config\.ya?ml|tsconfig(?:\.[^.]+)?\.json)$/.test(name)
    ) return 2;
    return 99;
  };
  return files
    .map((path) => ({ path, priority: priority(path) }))
    .filter((entry) => entry.priority < 99)
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        left.path.split('/').length - right.path.split('/').length ||
        left.path.localeCompare(right.path)
    )
    .slice(0, limit)
    .map((entry) => entry.path);
}

export interface ExactOccurrenceContext {
  id: string;
  path: string;
  line: number;
  snippet: string;
}

export function exactOccurrenceContexts(
  files: Array<{ path: string; content: string }>,
  needle: string,
  limit = 20
): { contexts: ExactOccurrenceContext[]; truncated: boolean } {
  if (!needle) return { contexts: [], truncated: false };
  const contexts: ExactOccurrenceContext[] = [];
  let total = 0;
  for (const file of files) {
    let from = 0;
    while (from <= file.content.length - needle.length) {
      const index = file.content.indexOf(needle, from);
      if (index === -1) break;
      total += 1;
      if (contexts.length < limit) {
        const before = file.content.slice(0, index);
        const line = before.split('\n').length;
        const lines = file.content.split('\n');
        const start = Math.max(0, line - 2);
        const end = Math.min(lines.length, line + 1);
        const snippet = lines
          .slice(start, end)
          .map((text, offset) => `L${start + offset + 1}: ${text.slice(0, 260)}`)
          .join('\n');
        contexts.push({ id: `M${contexts.length + 1}`, path: file.path, line, snippet });
      }
      from = index + Math.max(1, needle.length);
    }
  }
  return { contexts, truncated: total > contexts.length };
}

export interface DeclaredScript {
  path: string;
  name: string;
  command: string;
}

export function extractDeclaredQualityScripts(
  files: Array<{ path: string; content: string }>,
  limit = 30
): DeclaredScript[] {
  const scripts: DeclaredScript[] = [];
  const useful = /(test|spec|lint|format|type|check|verify|validate|build|security|audit|deploy|quality|ci|guard)/i;
  for (const file of files) {
    if (!file.path.toLowerCase().endsWith('package.json')) continue;
    try {
      const parsed = JSON.parse(file.content.replace(/^\uFEFF/, '')) as { scripts?: Record<string, unknown> };
      if (!parsed.scripts || typeof parsed.scripts !== 'object') continue;
      for (const [name, command] of Object.entries(parsed.scripts)) {
        if (typeof command !== 'string' || !useful.test(`${name} ${command}`)) continue;
        scripts.push({ path: file.path, name, command: command.slice(0, 240) });
        if (scripts.length >= limit) return scripts;
      }
    } catch {
      // Invalid JSON is already surfaced by the post-commit advisory path.
    }
  }
  return scripts;
}

export function isCodeownersPath(path: string): boolean {
  const normalized = path.replace(/^\.\//, '').toLowerCase();
  return normalized === 'codeowners' || normalized === '.github/codeowners' || normalized === 'docs/codeowners';
}

export function isDependencyManifestPath(path: string): boolean {
  const name = path.toLowerCase().split('/').pop() ?? path.toLowerCase();
  return (
    /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb?|deno\.lock)$/.test(name) ||
    /^(?:cargo\.toml|cargo\.lock|go\.mod|go\.sum|gemfile|gemfile\.lock|composer\.json|composer\.lock|pyproject\.toml|poetry\.lock|pipfile|pipfile\.lock|uv\.lock|pubspec\.ya?ml|pubspec\.lock|pom\.xml|gradle\.lockfile|packages\.lock\.json)$/.test(name) ||
    /^requirements(?:[-_.].+)?\.txt$/.test(name) ||
    /\.(?:csproj|fsproj|vbproj)$/.test(name) ||
    /^(?:build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/.test(name)
  );
}

export function repositoryStats(entries: RepositoryTreeEntry[]): {
  files: number;
  bytes: number;
  lines: string[];
} {
  const files = entries.filter((entry) => entry.type === 'file');
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const folders = new Map<string, { files: number; bytes: number }>();
  const extensions = new Map<string, { files: number; bytes: number }>();

  for (const file of files) {
    const slash = file.path.indexOf('/');
    const folder = slash === -1 ? '(root)' : file.path.slice(0, slash);
    const folderStats = folders.get(folder) ?? { files: 0, bytes: 0 };
    folderStats.files += 1;
    folderStats.bytes += file.size;
    folders.set(folder, folderStats);

    const name = file.path.split('/').pop() ?? file.path;
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot).toLowerCase() : '(none)';
    const extensionStats = extensions.get(extension) ?? { files: 0, bytes: 0 };
    extensionStats.files += 1;
    extensionStats.bytes += file.size;
    extensions.set(extension, extensionStats);
  }

  const top = (values: Map<string, { files: number; bytes: number }>, count: number) =>
    [...values.entries()]
      .sort((left, right) => right[1].bytes - left[1].bytes || right[1].files - left[1].files)
      .slice(0, count);

  const directories = entries.filter((entry) => entry.type === 'dir');
  const deepest = [...files].sort(
    (left, right) => right.path.split('/').length - left.path.split('/').length || right.path.length - left.path.length
  )[0];
  const longest = [...files].sort((left, right) => right.path.length - left.path.length)[0];
  const directChildren = new Map<string, number>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    const parent = parts.length === 1 ? '(root)' : parts.slice(0, -1).join('/');
    directChildren.set(parent, (directChildren.get(parent) ?? 0) + 1);
  }
  const widest = [...directChildren.entries()].sort((left, right) => right[1] - left[1])[0];

  const lines = [`TOTAL · ${files.length} files · ${directories.length} dirs · ${humanBytes(bytes)}`];
  for (const [folder, stats] of top(folders, 6)) {
    lines.push(`FOLDER ${folder === '(root)' ? folder : `${folder}/`} · ${stats.files} files · ${humanBytes(stats.bytes)}`);
  }
  for (const [extension, stats] of top(extensions, 6)) {
    lines.push(`TYPE ${extension} · ${stats.files} files · ${humanBytes(stats.bytes)}`);
  }
  for (const file of [...files].sort((left, right) => right.size - left.size).slice(0, 6)) {
    lines.push(`LARGE ${file.path} · ${humanBytes(file.size)}`);
  }
  if (deepest) lines.push(`SHAPE max depth ${deepest.path.split('/').length} · ${deepest.path}`);
  if (longest) lines.push(`SHAPE longest path ${longest.path.length} chars · ${longest.path}`);
  if (widest) lines.push(`SHAPE widest ${widest[0]} · ${widest[1]} direct entries`);

  return { files: files.length, bytes, lines };
}

export function repositoryMap(entries: RepositoryTreeEntry[]): string[] {
  const files = entries.filter((entry) => entry.type === 'file');
  const buckets = new Map<string, { files: number; bytes: number }>();
  const bump = (bucket: string, size: number) => {
    const current = buckets.get(bucket) ?? { files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += size;
    buckets.set(bucket, current);
  };

  const category = (path: string): string => {
    const lower = path.toLowerCase();
    const name = lower.split('/').pop() ?? lower;
    if (/(^|\/)(test|tests|__tests__|spec|specs)(\/|$)/.test(lower) || /\.(test|spec)\.[^.]+$/.test(name)) return 'tests';
    if (lower.startsWith('.github/workflows/')) return 'automation';
    if (/(^|\/)(migrations?|schema)(\/|$)/.test(lower) || /(^|\/)(schema|migration)[^/]*\.(sql|ts|js|py)$/.test(lower)) return 'data/schema';
    if (/(^|\/)(assets?|public|static|images?|icons?)(\/|$)/.test(lower)) return 'assets';
    if (lower.startsWith('docs/') || /(^|\/)(readme|changelog|contributing|license)(\.|$)/.test(lower) || /\.(md|mdx|rst)$/.test(lower)) return 'docs';
    if (
      lower.startsWith('.github/') ||
      name.startsWith('.') ||
      /^(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig.*\.json|pyproject\.toml|cargo\.toml|go\.mod|makefile|dockerfile|wrangler\.jsonc|[^/]*config\.(?:[cm]?[jt]s|json|jsonc|ya?ml|toml))$/.test(name)
    ) return 'config';
    if (/(^|\/)(src|app|lib|packages?|crates?)(\/|$)/.test(lower)) return 'source';
    return 'other';
  };

  for (const file of files) bump(category(file.path), file.size);

  const lines = [...buckets.entries()]
    .sort((left, right) => right[1].bytes - left[1].bytes || right[1].files - left[1].files)
    .map(([bucket, stats]) => `AREA ${bucket} · ${stats.files} files · ${humanBytes(stats.bytes)}`);

  const entryName = /^(?:index|main|app|server|worker|cli)\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift)$/i;
  const likelyEntries = files
    .filter((file) => {
      const name = file.path.split('/').pop() ?? file.path;
      return entryName.test(name) || /^(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod|wrangler\.jsonc)$/i.test(file.path);
    })
    .sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path))
    .slice(0, 10);
  for (const file of likelyEntries) lines.push(`ENTRY? ${file.path}`);

  return lines;
}

export interface PatchHunk {
  id: string;
  path: string;
  header: string;
  text: string;
}

export function splitPatchHunks(files: ChangedFile[], limit = 200): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  for (const file of files) {
    if (!file.patch) continue;
    const parts = file.patch.split(/(?=^@@)/m).filter((part) => part.trim().length > 0);
    for (const part of parts) {
      if (hunks.length >= limit) return hunks;
      const lines = part.split('\n');
      const header = lines[0]?.startsWith('@@') ? lines[0] : '(patch context)';
      hunks.push({
        id: `H${hunks.length + 1}`,
        path: file.path,
        header,
        text: part.slice(0, 5000)
      });
    }
  }
  return hunks;
}

export function representativePatchHunks(hunks: PatchHunk[], query: string, limit = 120): PatchHunk[] {
  if (hunks.length <= limit) return hunks;
  const tokens = query.toLowerCase().match(/[a-z0-9_/-]{2,}/g) ?? [];
  const scored = hunks
    .map((hunk) => ({
      hunk,
      score: tokens.reduce((sum, token) => sum + (hunk.text.toLowerCase().includes(token) ? 1 : 0), 0)
    }))
    .sort((left, right) => right.score - left.score || left.hunk.id.localeCompare(right.hunk.id));
  const selected = new Map<string, PatchHunk>();
  for (const entry of scored.slice(0, Math.min(60, limit))) {
    if (entry.score > 0) selected.set(entry.hunk.id, entry.hunk);
  }
  const remainingSlots = limit - selected.size;
  if (remainingSlots > 0) {
    for (let index = 0; index < remainingSlots; index += 1) {
      const at = Math.min(hunks.length - 1, Math.floor((index * hunks.length) / remainingSlots));
      selected.set(hunks[at]!.id, hunks[at]!);
    }
  }
  return [...selected.values()].slice(0, limit);
}

export interface PatchIdentifierCandidate {
  identifier: string;
  occurrences: number;
  paths: string[];
}

export function patchIdentifierCandidates(
  files: ChangedFile[],
  limit = 100
): PatchIdentifierCandidate[] {
  const ignored = new Set([
    'const', 'let', 'var', 'function', 'return', 'export', 'import', 'from', 'async', 'await',
    'class', 'interface', 'type', 'extends', 'implements', 'public', 'private', 'protected',
    'readonly', 'static', 'default', 'new', 'this', 'true', 'false', 'null', 'undefined',
    'string', 'number', 'boolean', 'object', 'unknown', 'void', 'any', 'if', 'else', 'for',
    'while', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw',
    'error', 'data', 'value', 'result', 'props', 'state'
  ]);
  const found = new Map<string, { occurrences: number; paths: Set<string> }>();
  for (const file of files) {
    if (!file.patch) continue;
    for (const line of file.patch.split('\n')) {
      if (!line.startsWith('-') || line.startsWith('---')) continue;
      for (const match of line.slice(1).matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]{3,}\b/g)) {
        const identifier = match[0];
        if (ignored.has(identifier.toLowerCase())) continue;
        const current = found.get(identifier) ?? { occurrences: 0, paths: new Set<string>() };
        current.occurrences += 1;
        current.paths.add(file.path);
        found.set(identifier, current);
      }
    }
  }
  return [...found.entries()]
    .map(([identifier, value]) => ({
      identifier,
      occurrences: value.occurrences,
      paths: [...value.paths]
    }))
    .sort((left, right) => right.occurrences - left.occurrences || left.identifier.localeCompare(right.identifier))
    .slice(0, limit);
}

export function fileTotals(files: ChangedFile[]): { files: number; additions: number; deletions: number } {
  return files.reduce(
    (sum, file) => ({
      files: sum.files + 1,
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions
    }),
    { files: 0, additions: 0, deletions: 0 }
  );
}

export function changeHotspots(files: ChangedFile[]): string[] {
  const folders = new Map<string, { files: number; additions: number; deletions: number }>();
  for (const file of files) {
    const slash = file.path.indexOf('/');
    const folder = slash === -1 ? '(root)' : `${file.path.slice(0, slash)}/`;
    const current = folders.get(folder) ?? { files: 0, additions: 0, deletions: 0 };
    current.files += 1;
    current.additions += file.additions;
    current.deletions += file.deletions;
    folders.set(folder, current);
  }
  return [...folders.entries()]
    .sort(
      (left, right) =>
        right[1].additions + right[1].deletions - (left[1].additions + left[1].deletions) ||
        right[1].files - left[1].files
    )
    .slice(0, 4)
    .map(([folder, stats]) => `${folder} ${stats.files} file${stats.files === 1 ? '' : 's'} +${stats.additions}/-${stats.deletions}`);
}

/**
 * Cheap post-commit checks over the exact text and tree GitHub stored.
 * These are advisory only: the commit already exists before they run.
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

  const sourceLike = /\.(?:[cm]?[jt]sx?|py|go|rs|swift|java|kt|kts|cs|php|rb|css|scss|html|sql)$/i;

  for (const file of files) {
    if (!file.content) continue;

    if (sourceLike.test(file.path) && /^(?:<<<<<<< |=======\s*$|>>>>>>> )/m.test(file.content)) {
      warnings.push(`Post-commit notice: ${file.path} contains merge-conflict markers.`);
    }

    if (/\.json$/i.test(file.path)) {
      try {
        JSON.parse(file.content.replace(/^\uFEFF/, ''));
      } catch {
        warnings.push(`Post-commit notice: ${file.path} is not valid JSON.`);
      }
    }

    const importMatches = file.content.matchAll(/(?:from\s+|(?:import|require)\s*(?:\(\s*)?)['"](\.[^'"]+)['"]/g);
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
