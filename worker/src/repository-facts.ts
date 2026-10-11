/**
 * Deterministic summaries over one immutable GitHub tree.
 *
 * Forge V2 keeps semantic routing, structural parsing and execution evidence in
 * their dedicated modules. Nothing here guesses reachability or code health.
 */
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

export interface MigrationHistoryEvidence {
  files: number;
  issues: number;
  lines: string[];
  duplicates: Array<{ directory: string; prefix: string; paths: string[] }>;
  checkerPaths: string[];
}

/** Numbering evidence only. SQL effects and deployment compatibility are separate evidence. */
export function migrationHistoryEvidence(entries: RepositoryTreeEntry[]): MigrationHistoryEvidence {
  const files = entries.filter((entry) => entry.type === 'file').map((entry) => entry.path);
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
  const duplicates: MigrationHistoryEvidence['duplicates'] = [];
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
      duplicates.push({ directory, prefix, paths: [...paths] });
      lines.push(`DUPLICATE? ${directory}/ · prefix ${prefix} · ${paths.join(', ')}`);
    }
    const numbers = new Set(sorted.map((migration) => migration.number));
    const highest = Math.max(0, ...numbers);
    if (numbers.has(1) && highest <= 9999) {
      const shownMissing: string[] = [];
      let missingCount = 0;
      for (let number = 1; number <= highest; number += 1) {
        if (numbers.has(number)) continue;
        missingCount += 1;
        if (shownMissing.length < 20) shownMissing.push(String(number).padStart(4, '0'));
      }
      if (missingCount > 0) {
        issues += missingCount;
        lines.push(`MISSING? ${directory}/ · ${shownMissing.join(', ')}${missingCount > shownMissing.length ? ` … (${missingCount} missing total)` : ''}`);
      }
    }
  }
  for (const checker of checkers) lines.push(`CHECKER ${checker}`);
  if (migrations.length === 0) lines.push('No numbered SQL migration files were found under a migrations/ directory.');
  return { files: migrations.length, issues, lines, duplicates, checkerPaths: checkers };
}

export function qualityCandidatePaths(values: readonly (RepositoryTreeEntry | string)[], limit = 16): string[] {
  const files = values.flatMap((value) =>
    typeof value === 'string' ? [value] : value.type === 'file' ? [value.path] : []
  );
  const priority = (path: string): number => {
    const lower = path.toLowerCase();
    const name = lower.split('/').pop() ?? lower;
    if (lower.startsWith('.github/workflows/') && /\.ya?ml$/.test(lower)) return 0;
    if (name === 'package.json') return 1;
    if (/^(?:makefile|justfile|pyproject\.toml|tox\.ini|pytest\.ini|cargo\.toml|go\.mod|biome\.jsonc?|eslint\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|ruff\.toml|\.pre-commit-config\.ya?ml|dependabot\.ya?ml|codeql-config\.ya?ml|tsconfig(?:\.[^.]+)?\.json)$/.test(name)) return 2;
    return 99;
  };
  return files
    .map((path) => ({ path, priority: priority(path) }))
    .filter((entry) => entry.priority < 99)
    .sort((left, right) => left.priority - right.priority || left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map((entry) => entry.path);
}

export interface DeclaredScript {
  path: string;
  name: string;
  command: string;
}

export function extractDeclaredQualityScripts(files: Array<{ path: string; content: string }>, limit = 30): DeclaredScript[] {
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
      // Unreadable configuration is not converted into an execution claim.
    }
  }
  return scripts;
}

export function repositoryStats(entries: RepositoryTreeEntry[]): { files: number; bytes: number; lines: string[] } {
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
    [...values.entries()].sort((left, right) => right[1].bytes - left[1].bytes || right[1].files - left[1].files).slice(0, count);
  const directories = entries.filter((entry) => entry.type === 'dir');
  const deepest = [...files].sort((left, right) => right.path.split('/').length - left.path.split('/').length || right.path.length - left.path.length)[0];
  const longest = [...files].sort((left, right) => right.path.length - left.path.length)[0];
  const directChildren = new Map<string, number>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    const parent = parts.length === 1 ? '(root)' : parts.slice(0, -1).join('/');
    directChildren.set(parent, (directChildren.get(parent) ?? 0) + 1);
  }
  const widest = [...directChildren.entries()].sort((left, right) => right[1] - left[1])[0];
  const lines = [`TOTAL · ${files.length} files · ${directories.length} dirs · ${humanBytes(bytes)}`];
  for (const [folder, stats] of top(folders, 6)) lines.push(`FOLDER ${folder === '(root)' ? folder : `${folder}/`} · ${stats.files} files · ${humanBytes(stats.bytes)}`);
  for (const [extension, stats] of top(extensions, 6)) lines.push(`TYPE ${extension} · ${stats.files} files · ${humanBytes(stats.bytes)}`);
  for (const file of [...files].sort((left, right) => right.size - left.size).slice(0, 6)) lines.push(`LARGE ${file.path} · ${humanBytes(file.size)}`);
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
    if (lower.startsWith('.github/') || name.startsWith('.') || /^(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig.*\.json|pyproject\.toml|cargo\.toml|go\.mod|makefile|dockerfile|wrangler\.jsonc|[^/]*config\.(?:[cm]?[jt]s|json|jsonc|ya?ml|toml))$/.test(name)) return 'config';
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
