import type { ReadInput, ToolContext, ToolOutcome } from './tool-types';
import { Snapshot, resolveCommit } from './snapshot';
import { ForgeError, toForgeError } from './errors';
import { CONTEXT_LIMITS, mapBounded, requirePath, requireSha, utf8Bytes } from './evidence';
import { githubAddress, resolveRepositoryName } from './addresses';
import { findChange, openChanges, openChangesTruncated } from './change';
import { compare, listRepos } from './read';
import { discoverPublic } from './public-discovery';
import { compileContext } from './context-compiler';
import { findInSnapshot } from './archive';
import { outline, parseSelector, selectSource } from './selectors';
import { readChecks } from './checks';
import { readAnalysisArtifact } from './analysis-artifact';
import { upstreamEvidence } from './upstream';
import { readBranchPolicy, readRecentChurn, readRecentHistory, readRepositoryLanguages } from './github-intelligence';
import { extractDeclaredQualityScripts, migrationHistoryEvidence, qualityCandidatePaths, repositoryMap, repositoryStats } from './repository-intelligence';

export async function readRepository(ctx: ToolContext, input: ReadInput): Promise<ToolOutcome> {
  const query = input.query?.trim() ?? '';
  if (input.repo === 'global') {
    if (input.at || input.change || input.paths) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Global discovery cannot also target private revisions, changes or files.' });
    return discoverPublic(ctx, query);
  }
  if (!input.repo) {
    if (input.at || input.change || input.paths) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Name the repository for a source or change read.' });
    const repos = await listRepos(ctx.gh, query || undefined);
    const sorted = [...repos].sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
    return { summary: `${repos.length} reachable repositories.`, structured: { repos: sorted.slice(0, 50), limits: sorted.length > 50 ? ['Repository list is bounded to the first 50 matches.'] : [], next: 'Name an owner/repo, or explicitly use repo="global" for public discovery.' } };
  }
  const urlAddress = input.repo.startsWith('https://') ? await githubAddress(ctx.gh, input.repo) : null;
  if (urlAddress && (input.at || input.change || (urlAddress.paths && input.paths))) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'The GitHub URL already selects a source. Do not supply conflicting revision, change or path selectors.' });
  const repo = urlAddress?.repo ?? await resolveRepositoryName(ctx.gh, input.repo, ctx.identity.githubLogin);
  if (input.at && input.at !== 'proposal') requireSha(input.at);
  const change = input.change || input.at === 'proposal' ? await findChange(ctx.gh, repo, input.change ?? 'forge') : null;
  const ref = urlAddress?.at ?? (input.at === 'proposal' ? change!.branch : input.at) ?? change?.branch;
  const snapshot = await Snapshot.open(ctx.gh, repo, ref);
  const changes = await openChanges(snapshot.gh, repo);
  const names = changes.map((entry) => entry.name);
  const changesLimits = openChangesTruncated(changes) ? ['The open-change list is bounded; additional changes may exist.'] : [];
  const finish = (summary: string, evidence: Record<string, unknown>, limits: string[] = []): ToolOutcome => ({ summary, structured: { source: snapshot.identity, ...evidence, changes: names, limits: [...changesLimits, ...limits] } });
  const paths = urlAddress?.paths ?? input.paths;

  // Change + paths is a patch read. at="proposal" is explicitly a source read.
  if (change && !input.at && !urlAddress) {
    const baseSha = await resolveCommit(snapshot.gh, repo, snapshot.branch);
    const comparison = await compare(snapshot.gh, repo, baseSha, snapshot.identity.sha, paths);
    if (!query || query === 'diff' || paths?.length) return finish(`Change ${comparison.status} against ${snapshot.branch}.`, {
      baseSha,
      diff: { status: comparison.status, ahead: comparison.aheadBy, behind: comparison.behindBy, files: comparison.files.slice(0, 200).map((file) => ({ path: file.path, change: `${file.status} +${file.additions}/-${file.deletions}`, ...(file.patch !== undefined ? { patch: file.patch } : {}) })) },
      next: 'Use at="proposal" with paths to read actual proposal contents rather than patches.'
    }, comparison.truncated ? ['GitHub comparison is incomplete.'] : []);
  }
  if (paths?.length) {
    if (paths.length > 20) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'At most 20 exact source selections are accepted.' });
    const results = await mapBounded(paths, async (path) => {
      try {
        const selector = parseSelector(path);
        const file = await snapshot.file(selector.path);
        const selected = selectSource(selector, file.text);
        return { file: { path: selector.path, selector: path, blob: file.blob, ...selected } };
      } catch (error) { return { error: `${path}: ${toForgeError(error).message}` }; }
    });
    const files = results.flatMap((result) => result.file ? [result.file] : []);
    const limits = results.flatMap((result) => result.error ? [result.error] : []);
    if (!files.length) throw new ForgeError({ code: 'FORGE_NOT_FOUND', message: `None of the exact selections could be read. ${limits.join(' ')}` });
    if (utf8Bytes(JSON.stringify(files)) > 64 * 1024) throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: 'The exact selections exceed the response budget. Request named symbols, records or smaller explicit ranges; source was not silently excerpted.' });
    if (query) limits.push('Explicit source selectors took precedence over the question; no semantic excerpt replaced their contents.');
    return finish(`${files.length} exact source selections at ${snapshot.identity.sha.slice(0, 7)}.`, { files, coverage: limits.length ? 'bounded' : 'complete' }, limits);
  }
  if (/^(?:checks|check results|test results)$/i.test(query)) return finish('GitHub execution evidence for the selected commit.', { checks: await readChecks(snapshot.gh, repo, snapshot.identity.sha) });
  if (/^(?:analysis|analysis artifact)$/i.test(query)) return finish('Repository-produced analysis for the exact workflow run.', { analysis: await readAnalysisArtifact(snapshot) });
  const upstream = /^upstream\s+(.+)$/i.exec(query);
  if (upstream) return finish('Public upstream references joined with private source locations.', { upstream: await upstreamEvidence(snapshot, ctx.ghUser, upstream[1]!) });
  const symbols = /^(?:outline|symbols)\s+(.+)$/i.exec(query);
  if (symbols) {
    const path = requirePath(symbols[1]!);
    const file = await snapshot.file(path);
    const text = outline(path, file.text);
    if (utf8Bytes(text) > CONTEXT_LIMITS.maxOutputBytes) throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: 'The complete outline exceeds the response budget. Request a named symbol.' });
    return finish('Parser-backed source outline, not a runtime reference graph.', { files: [{ path, blob: file.blob, text, representation: 'outline' }] });
  }
  const exact = /^(?:find|text):([\s\S]+)$/.exec(query);
  if (exact) {
    const matches = await findInSnapshot(snapshot.gh, repo, snapshot.identity.sha, exact[1]!, snapshot.budget);
    return finish(`${matches.matchedFiles} matching files in the scanned scope.`, { search: matches }, ['Exact literal committed-source search; no code-index fallback or semantic occurrence classification.']);
  }
  const history = /^history(?:\s+(.+))?$/i.exec(query);
  if (history) {
    const historyPath = history[1] ? requirePath(history[1]) : undefined;
    const result = await readRecentHistory(snapshot.gh, repo, snapshot.identity.sha, historyPath);
    const { commits, ...rest } = result;
    return finish('Bounded history leading to the selected commit.', { history: { ...rest, commits: commits.map(({ verified, ...commit }) => ({ ...commit, signatureVerified: verified })) } }, ['Commit signatures do not establish that tests ran or passed.']);
  }
  if (/^(?:churn|hotspots)$/i.test(query)) return finish('Recent committed-file churn, not a health score.', { churn: await readRecentChurn(snapshot.gh, repo, snapshot.identity.sha) });
  if (/^(?:policy|branch protection|required checks)$/i.test(query)) return finish('Current GitHub branch policy, observed separately from immutable source.', { policy: await readBranchPolicy(snapshot.gh, repo, snapshot.branch), observedAt: new Date().toISOString() });
  if (/^(?:languages|stack)$/i.test(query)) return finish('Current GitHub language metadata, not a commit-pinned compilation report.', { languages: await readRepositoryLanguages(snapshot.gh, repo), observedAt: new Date().toISOString() });
  const structural = /^(stats|map|instructions)(?:\s+(.+))?$/i.exec(query);
  if (!query || structural || /^(?:quality|dependencies|migrations|migration safety)$/i.test(query)) {
    const tree = await snapshot.tree();
    const scope = structural?.[2] ? requirePath(structural[2]) : '';
    const entries = scope ? tree.entries.filter((entry) => entry.path === scope || entry.path.startsWith(`${scope}/`)) : tree.entries;
    const limits = tree.truncated ? ['GitHub tree coverage is incomplete.'] : [];
    if (!query) return finish(`${snapshot.identity.repo} at ${snapshot.identity.requested}: ${entries.filter((entry) => entry.type === 'file').length} files.`, { tree: entries.filter((entry) => entry.type === 'file').slice(0, 300).map((entry) => entry.path) }, [...limits, ...(entries.length > 300 ? ['Returned tree is bounded to 300 paths.'] : [])]);
    if (structural?.[1]?.toLowerCase() === 'stats') return finish('Measurements from the selected Git tree.', { tree: repositoryStats(entries).lines }, limits);
    if (structural?.[1]?.toLowerCase() === 'map') return finish('Repository area map; entrypoints are path-based candidates.', { tree: repositoryMap(entries) }, limits);
    const knownPaths = entries.filter((entry) => entry.type === 'file').map((entry) => entry.path);
    if (structural?.[1]?.toLowerCase() === 'instructions') {
      const all = new Set(tree.entries.map((entry) => entry.path));
      const segments = scope ? scope.split('/') : [];
      const targets: string[] = [];
      for (let index = 0; index <= segments.length; index++) {
        const prefix = segments.slice(0, index).join('/');
        for (const name of ['AGENTS.md', 'SIMPLE.md']) { const path = prefix ? `${prefix}/${name}` : name; if (all.has(path)) targets.push(path); }
      }
      const files = await mapBounded(targets, async (path) => { const file = await snapshot.file(path); return { path, blob: file.blob, text: file.text }; });
      if (utf8Bytes(JSON.stringify(files)) > 64 * 1024) throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: 'Applicable instructions exceed the source response budget; request their exact paths individually.' });
      return finish('Applicable instruction files in root-to-leaf order, preserved verbatim.', { files }, limits);
    }
    if (/^migration/i.test(query)) return finish('Numbered migration history only; deployment compatibility is not established.', { migrations: migrationHistoryEvidence(entries) }, [...limits, 'SQL effect analysis has not been admitted. Filename ordering does not prove rollback safety.']);
    const targets = query.toLowerCase() === 'dependencies' ? knownPaths.filter((path) => /(?:^|\/)package\.json$/.test(path)).slice(0, 12) : qualityCandidatePaths(knownPaths, 12);
    const files = await mapBounded(targets, async (path) => ({ path, content: (await snapshot.file(path)).text }));
    if (query.toLowerCase() === 'dependencies') {
      const declarations = files.map((file) => {
        const parsed = JSON.parse(file.content) as Record<string, unknown>;
        return { path: file.path, dependencies: parsed.dependencies, devDependencies: parsed.devDependencies, peerDependencies: parsed.peerDependencies };
      });
      return finish('Declared package constraints, not resolved dependency or vulnerability evidence.', { declarations }, [...limits, 'Dependency declarations are bounded to 12 manifests. No hosted security or package service was contacted.']);
    }
    return finish('Committed quality configuration; nothing was executed by Forge.', { scripts: extractDeclaredQualityScripts(files), configurations: files.map((file) => file.path) }, limits);
  }
  const context = await compileContext(snapshot, ctx.env, query.replace(/^context:\s*/i, ''));
  ctx.track('context_compiled', { github_calls: snapshot.budget.calls, jev_stages: snapshot.budget.jevStages, output_bytes: utf8Bytes(JSON.stringify(context)), ms: Date.now() - snapshot.budget.started });
  return finish('Task-specific repository evidence; missing and unsupported evidence remain explicit.', { context });
}
