import type { Snapshot as SnapshotType } from './snapshot';
import { Snapshot } from './snapshot';
import { parseRepo } from './github';
import { ForgeError } from './errors';
import { inspectStructure } from './structure';
import { scanArchive } from './archive';

/** Reviewed public dependency identities, not a global index or inferred package/tag equivalence. */
const UPSTREAM: Readonly<Record<string, string>> = Object.freeze({
  playwright: 'microsoft/playwright',
  '@playwright/test': 'microsoft/playwright',
  typescript: 'microsoft/TypeScript',
  astro: 'withastro/astro',
  '@astrojs/compiler': 'withastro/compiler',
  wrangler: 'cloudflare/workers-sdk',
  zod: 'colinhacks/zod',
  '@modelcontextprotocol/sdk': 'modelcontextprotocol/typescript-sdk'
});
export async function upstreamEvidence(snapshot: SnapshotType, publicPackage: string): Promise<Record<string, unknown>> {
  const repoName = UPSTREAM[publicPackage];
  if (!repoName) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'This public package has no reviewed upstream mapping. No private package name or identifier was sent to public discovery.' });
  const tree = await snapshot.tree();
  const manifests = tree.entries.filter((entry) => entry.type === 'file' && /(?:^|\/)package\.json$/.test(entry.path) && !/(?:^|\/)(?:node_modules|vendor|dist)\//.test(entry.path));
  const declarations: Array<{ path: string; constraint: string; section: string }> = [];
  for (const manifest of manifests.slice(0, 8)) {
    const file = await snapshot.file(manifest.path);
    let data: unknown;
    try { data = JSON.parse(file.text); } catch { throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: `${manifest.path} is not valid package JSON.` }); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const values = (data as Record<string, unknown>)[section];
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      const version = (values as Record<string, unknown>)[publicPackage];
      if (typeof version === 'string') declarations.push({ path: manifest.path, constraint: version, section });
    }
  }
  if (!declarations.length) throw new ForgeError({ code: 'FORGE_NOT_FOUND', message: 'This reviewed public dependency was not found in the inspected package manifests. No upstream request was made.' });
  const uses: Array<{ path: string; line: number; specifier: string }> = [];
  const coverage = await scanArchive(snapshot.gh, snapshot.repo, snapshot.identity.sha, snapshot.budget, (path) => /\.[cm]?[jt]sx?$/.test(path) && !/(?:^|\/)(?:node_modules|vendor|dist)\//.test(path), (path, text) => {
    if (new TextEncoder().encode(text).length > 256 * 1024) return;
    const parsed = inspectStructure(path, text);
    if (parsed.diagnostics.length) return;
    for (const imported of parsed.imports) if (imported.specifier === publicPackage || imported.specifier.startsWith(`${publicPackage}/`)) {
      if (uses.length < 40) uses.push({ path, line: imported.range.startLine, specifier: imported.specifier });
    }
  });
  // Only a reviewed public repository identity crosses this join. No private query, path or source is sent.
  const upstream = await Snapshot.open(snapshot.gh, parseRepo(repoName), undefined, snapshot.budget);
  if (upstream.identity.private) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'The reviewed upstream is no longer public. The join was refused.' });
  const upstreamTree = await upstream.tree();
  const references = upstreamTree.entries.filter((entry) => entry.type === 'file' && /(?:^|\/)(?:README(?:\.md)?|CHANGELOG\.md|LICENSE(?:\.txt)?|package\.json)$/.test(entry.path)).map((entry) => entry.path).slice(0, 12);
  return {
    source: snapshot.identity,
    publicPackage,
    declarations,
    uses,
    upstream: { source: upstream.identity, references },
    coverage: 'bounded',
    limits: [
      ...coverage.omissions,
      `Inspected ${Math.min(manifests.length, 8)} of ${manifests.length} manifests; code-use coverage is JS/TS syntax only.`,
      'Manifest constraints are not resolved installed versions. Public upstream HEAD is not proof of the published package implementation.',
      'Private source locations were joined inside Forge and were not sent to public search or inference.',
      'Read the returned upstream at its exact SHA before using or copying a public implementation.'
    ]
  };
}
