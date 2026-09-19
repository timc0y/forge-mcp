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

export function isPolicyQuery(query: string): boolean {
  return /^(?:policy|rules|ruleset|rulesets|branch protection|required checks)$/i.test(query.trim());
}

/** Paths whose committed diff can change the dependency graph. */
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

  const lines = [`TOTAL · ${files.length} files · ${humanBytes(bytes)}`];
  for (const [folder, stats] of top(folders, 6)) {
    lines.push(`FOLDER ${folder === '(root)' ? folder : `${folder}/`} · ${stats.files} files · ${humanBytes(stats.bytes)}`);
  }
  for (const [extension, stats] of top(extensions, 6)) {
    lines.push(`TYPE ${extension} · ${stats.files} files · ${humanBytes(stats.bytes)}`);
  }
  for (const file of [...files].sort((left, right) => right.size - left.size).slice(0, 6)) {
    lines.push(`LARGE ${file.path} · ${humanBytes(file.size)}`);
  }

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
