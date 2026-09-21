import type { GitHubRequest } from './contracts';
import type { Snapshot as SnapshotType } from './snapshot';
import { Snapshot } from './snapshot';
import { parseRepo } from './github';
import { ForgeError } from './errors';
import { inspectStructure } from './structure';
import { scanArchive } from './archive';
import { parseDocument } from 'yaml';
import { githubFailure, object } from './snapshot';

interface UpstreamMapping {
  repo: string;
  tags(version: string): string[];
}

/** Reviewed identities and tag conventions. There is no package registry or inferred repository search. */
const UPSTREAM: Readonly<Record<string, UpstreamMapping>> = Object.freeze({
  playwright: { repo: 'microsoft/playwright', tags: (version) => [`v${version}`] },
  '@playwright/test': { repo: 'microsoft/playwright', tags: (version) => [`v${version}`] },
  typescript: { repo: 'microsoft/TypeScript', tags: (version) => [`v${version}`] },
  astro: { repo: 'withastro/astro', tags: (version) => [`astro@${version}`, `v${version}`, version] },
  '@astrojs/compiler': { repo: 'withastro/compiler', tags: (version) => [`@astrojs/compiler@${version}`, `v${version}`, version] },
  wrangler: { repo: 'cloudflare/workers-sdk', tags: (version) => [`wrangler@${version}`, `v${version}`] },
  zod: { repo: 'colinhacks/zod', tags: (version) => [`v${version}`, version] },
  '@modelcontextprotocol/sdk': { repo: 'modelcontextprotocol/typescript-sdk', tags: (version) => [`v${version}`, version, `@modelcontextprotocol/sdk@${version}`] }
});

function directory(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function relativeDirectory(from: string, target: string): string | null {
  const fromParts = from ? from.split('/') : [];
  const targetParts = target ? target.split('/') : [];
  let common = 0;
  while (common < fromParts.length && common < targetParts.length && fromParts[common] === targetParts[common]) common++;
  if (common !== fromParts.length) return null;
  return targetParts.slice(common).join('/') || '.';
}

function exactVersion(value: unknown): string | null {
  const raw = typeof value === 'string' ? value : typeof object(value)?.version === 'string' ? object(value)!.version as string : null;
  if (!raw) return null;
  const match = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\(.*\))?$/.exec(raw);
  return match?.[1] ?? null;
}

async function installedPnpmVersions(
  snapshot: SnapshotType,
  manifests: readonly string[],
  packageName: string
): Promise<Array<{ manifest: string; lockfile: string; importer: string; version: string }>> {
  const tree = await snapshot.tree();
  const locks = tree.entries
    .filter((entry) => entry.type === 'file' && /(?:^|\/)pnpm-lock\.yaml$/.test(entry.path) && !/(?:^|\/)(?:node_modules|vendor|dist)\//.test(entry.path))
    .map((entry) => entry.path);
  const parsed = new Map<string, Record<string, unknown>>();
  const results: Array<{ manifest: string; lockfile: string; importer: string; version: string }> = [];

  for (const manifest of manifests) {
    const manifestDir = directory(manifest);
    const candidates = locks
      .map((lockfile) => ({ lockfile, lockDir: directory(lockfile) }))
      .filter(({ lockDir }) => manifestDir === lockDir || (lockDir ? manifestDir.startsWith(`${lockDir}/`) : true))
      .sort((a, b) => b.lockDir.length - a.lockDir.length);
    const nearest = candidates[0];
    if (!nearest) continue;
    let lock = parsed.get(nearest.lockfile);
    if (!lock) {
      const file = await snapshot.file(nearest.lockfile);
      const document = parseDocument(file.text, { prettyErrors: false, uniqueKeys: true });
      if (document.errors.length) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: `${nearest.lockfile} is not valid unique-key YAML; installed package identity is unavailable.` });
      let value: unknown;
      try { value = document.toJS({ maxAliasCount: 100 }); }
      catch { throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: `${nearest.lockfile} exceeds the admitted YAML alias-expansion bound; installed package identity is unavailable.` }); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: `${nearest.lockfile} has no lockfile object.` });
      lock = value as Record<string, unknown>;
      parsed.set(nearest.lockfile, lock);
    }
    const importer = relativeDirectory(nearest.lockDir, manifestDir);
    if (!importer) continue;
    const importers = object(lock.importers);
    const row = object(importers?.[importer]);
    if (!row) continue;
    let version: string | null = null;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const values = object(row[section]);
      const found = exactVersion(values?.[packageName]);
      if (found) {
        if (version && version !== found) throw new ForgeError({ code: 'FORGE_AMBIGUOUS', message: `${manifest} resolves ${packageName} to more than one exact version in its pnpm importer.` });
        version = found;
      }
    }
    if (version) results.push({ manifest, lockfile: nearest.lockfile, importer, version });
  }
  return results;
}

async function pinnedUpstream(
  publicGh: GitHubRequest,
  mapping: UpstreamMapping,
  version: string,
  budget: SnapshotType['budget']
): Promise<{ snapshot: Snapshot; tag: string }> {
  const repo = parseRepo(mapping.repo);
  const found: string[] = [];
  for (const tag of [...new Set(mapping.tags(version))]) {
    budget.assert();
    budget.github();
    const encoded = tag.split('/').map(encodeURIComponent).join('/');
    const response = await publicGh(`/repos/${mapping.repo}/git/ref/tags/${encoded}`, { signal: AbortSignal.timeout(budget.remaining()) });
    if (response.status === 404) continue;
    if (response.status !== 200) githubFailure(response.status, `the reviewed upstream tag ${tag}`);
    const ref = object(response.json)?.ref;
    if (ref === `refs/tags/${tag}`) found.push(tag);
    else githubFailure(502, `the reviewed upstream tag ${tag}`);
  }
  if (!found.length) throw new ForgeError({ code: 'FORGE_NOT_FOUND', message: `No reviewed tag form resolves ${mapping.repo} for installed version ${version}. Upstream HEAD was not substituted.` });
  const snapshots = await Promise.all(found.map(async (tag) => ({ tag, snapshot: await Snapshot.open(publicGh, repo, `refs/tags/${tag}`, budget) })));
  const shas = new Set(snapshots.map((entry) => entry.snapshot.identity.sha));
  if (shas.size !== 1) throw new ForgeError({ code: 'FORGE_AMBIGUOUS', message: `Reviewed tag forms for ${mapping.repo} version ${version} resolve to different commits. No tag was preferred.` });
  const selected = snapshots[0]!;
  if (selected.snapshot.identity.private) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'The reviewed upstream is no longer public. The join was refused.' });
  return selected;
}

export async function upstreamEvidence(snapshot: SnapshotType, publicGh: GitHubRequest, publicPackage: string): Promise<Record<string, unknown>> {
  const mapping = UPSTREAM[publicPackage];
  if (!mapping) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'This public package has no reviewed upstream mapping. No private package name or identifier was sent to public discovery.' });
  const tree = await snapshot.tree();
  if (tree.truncated) throw new ForgeError({ code: 'FORGE_UPSTREAM_UNAVAILABLE', message: 'Public-upstream version joining is unavailable because GitHub returned an incomplete repository tree. No dependency absence or version uniqueness was inferred.' });
  const manifests = tree.entries
    .filter((entry) => entry.type === 'file' && /(?:^|\/)package\.json$/.test(entry.path) && !/(?:^|\/)(?:node_modules|vendor|dist)\//.test(entry.path))
    .map((entry) => entry.path);
  if (manifests.length > 12) throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: `Public-upstream version joining is bounded to 12 package manifests; this repository has ${manifests.length}. No package absence or single-version claim was made.` });
  const declarations: Array<{ path: string; constraint: string; section: string }> = [];
  for (const manifest of manifests) {
    const file = await snapshot.file(manifest);
    let data: unknown;
    try { data = JSON.parse(file.text); } catch { throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: `${manifest} is not valid package JSON.` }); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const values = (data as Record<string, unknown>)[section];
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      const constraint = (values as Record<string, unknown>)[publicPackage];
      if (typeof constraint === 'string') declarations.push({ path: manifest, constraint, section });
    }
  }
  if (!declarations.length) throw new ForgeError({ code: 'FORGE_NOT_FOUND', message: 'This reviewed public dependency was not found in the inspected package manifests. No upstream request was made.' });

  const installed = await installedPnpmVersions(snapshot, [...new Set(declarations.map((entry) => entry.path))], publicPackage);
  const versions = [...new Set(installed.map((entry) => entry.version))];
  if (versions.length !== 1) {
    throw new ForgeError({
      code: versions.length ? 'FORGE_AMBIGUOUS' : 'FORGE_NOT_FOUND',
      message: versions.length
        ? `${publicPackage} resolves to multiple installed versions (${versions.join(', ')}). Name a narrower source before asking for upstream evidence.`
        : `No exact installed pnpm version was established for ${publicPackage}. A declared range and upstream HEAD were not substituted.`
    });
  }
  const version = versions[0]!;

  const uses: Array<{ path: string; line: number; specifier: string }> = [];
  const coverage = await scanArchive(snapshot.gh, snapshot.repo, snapshot.identity.sha, snapshot.budget, (path) => /\.[cm]?[jt]sx?$/.test(path) && !/(?:^|\/)(?:node_modules|vendor|dist)\//.test(path), (path, text) => {
    if (new TextEncoder().encode(text).length > 256 * 1024) return;
    const parsed = inspectStructure(path, text);
    if (parsed.diagnostics.length) return;
    for (const imported of parsed.imports) if (imported.specifier === publicPackage || imported.specifier.startsWith(`${publicPackage}/`)) {
      if (uses.length < 40) uses.push({ path, line: imported.range.startLine, specifier: imported.specifier });
    }
  });

  // Only a reviewed public repository identity and exact public version cross this join.
  const pinned = await pinnedUpstream(publicGh, mapping, version, snapshot.budget);
  const upstreamTree = await pinned.snapshot.tree();
  const references = upstreamTree.entries
    .filter((entry) => entry.type === 'file' && /(?:^|\/)(?:README(?:\.md)?|CHANGELOG\.md|LICENSE(?:\.txt)?|package\.json)$/.test(entry.path))
    .map((entry) => entry.path)
    .slice(0, 12);
  return {
    source: snapshot.identity,
    publicPackage,
    declarations,
    installed,
    version,
    uses,
    upstream: { source: pinned.snapshot.identity, tag: pinned.tag, references },
    coverage: coverage.coverage,
    limits: [
      ...coverage.omissions,
      `Inspected all ${manifests.length} package manifests; installed-version resolution is pnpm-lock only; code-use coverage is JS/TS syntax only.`,
      ...(uses.length >= 40 ? ['Private use locations are bounded to the first 40 syntax imports.'] : []),
      'Private source locations were joined inside Forge and were not sent to public search or inference.',
      'The upstream source is pinned to the exact commit resolved from a reviewed tag convention; published package bytes are still a separate artifact.'
    ]
  };
}
