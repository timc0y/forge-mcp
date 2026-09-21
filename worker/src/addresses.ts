import type { GitHubRequest, RepoRef } from './contracts';
import { formatRepo } from './contracts';
import { parseRepo } from './github';
import { listRepos } from './read';
import { ForgeError } from './errors';
import { requirePath, requireSha } from './evidence';
import { githubFailure, object } from './snapshot';

export interface RepositoryAddress { repo: RepoRef; at?: string; paths?: string[]; pull?: number }
export async function resolveRepositoryName(gh: GitHubRequest, value: string, login: string, creating = false): Promise<RepoRef> {
  const name = value.trim();
  if (name.includes('/')) return parseRepo(name);
  const matches = (await listRepos(gh)).filter((entry) => entry.repo.split('/')[1]?.toLowerCase() === name.toLowerCase());
  if (matches.length === 1) return parseRepo(matches[0]!.repo);
  if (matches.length > 1) throw new ForgeError({ code: 'FORGE_AMBIGUOUS', message: `More than one reachable repository is named ${name}. Supply owner/name.`, details: { candidates: matches.map((entry) => entry.repo) } });
  if (creating) return parseRepo(`${login}/${name}`);
  throw new ForgeError({ code: 'FORGE_NOT_FOUND', message: `No reachable repository has the exact name ${name}. Private lookup was not widened to public search.` });
}
/** URL interpretation uses GitHub ref identities, never a longest-segment guess. */
export async function githubAddress(gh: GitHubRequest, value: string): Promise<RepositoryAddress> {
  let url: URL;
  try { url = new URL(value); } catch { throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Invalid GitHub URL.' }); }
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || /(?:^|\/)\.\.?(?:\/|$)/.test(value)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Use a canonical HTTPS GitHub repository, blob, commit or pull-request URL.' });
  let parts: string[];
  try { parts = url.pathname.replace(/^\//, '').replace(/\/$/, '').split('/').map(decodeURIComponent); } catch { throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Invalid URL encoding.' }); }
  if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || /[\u0000-\u001f]/.test(part))) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Unsafe or incomplete GitHub URL path.' });
  const repo = parseRepo(`${parts[0]}/${parts[1]}`);
  const kind = parts[2];
  if (!kind) {
    if (url.hash) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Repository URL fragments are not source selectors.' });
    return { repo };
  }
  if (kind === 'commit' && parts.length === 4 && !url.hash) return { repo, at: requireSha(parts[3]!) };
  if (kind === 'pull' && parts.length === 4 && /^\d+$/.test(parts[3]!) && !url.hash) {
    const pull = Number(parts[3]);
    if (!Number.isSafeInteger(pull) || pull < 1) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Pull-request number is outside the supported integer range.' });
    const response = await gh(`/repos/${formatRepo(repo)}/pulls/${pull}`);
    if (response.status !== 200) githubFailure(response.status, 'the requested pull request');
    const head = object(object(response.json)?.head);
    const headRepo = object(head?.repo)?.full_name;
    if (typeof headRepo !== 'string' || headRepo.toLowerCase() !== formatRepo(repo).toLowerCase()) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Fork pull-request source requires an explicit authorized fork repository URL; no scope was widened.' });
    if (typeof head?.sha !== 'string') githubFailure(502, 'pull-request head identity');
    return { repo, at: requireSha(head.sha), pull };
  }
  if (kind !== 'blob' || parts.length < 5) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Unsupported GitHub URL form.' });
  const tail = parts.slice(3).join('/');
  const candidates: Array<{ ref: string; path: string }> = [];
  if (/^[0-9a-f]{40}$/.test(parts[3]!)) candidates.push({ ref: parts[3]!, path: parts.slice(4).join('/') });
  else {
    for (const group of ['heads', 'tags']) {
      const response = await gh(`/repos/${formatRepo(repo)}/git/matching-refs/${group}/${encodeURIComponent(parts[3]!)}`);
      if (response.status !== 200) githubFailure(response.status, 'source URL ref resolution');
      if (!Array.isArray(response.json) || response.json.length > 100 || /rel="next"/.test(response.headers.get('link') ?? '')) throw new ForgeError({ code: 'FORGE_AMBIGUOUS', message: 'Ref discovery is incomplete. Use a commit-pinned GitHub blob URL.' });
      for (const raw of response.json) {
        const full = object(raw)?.ref;
        const prefix = `refs/${group}/`;
        if (typeof full !== 'string' || !full.startsWith(prefix)) githubFailure(502, 'ref metadata');
        const ref = full.slice(prefix.length);
        if (tail.startsWith(`${ref}/`)) candidates.push({ ref: full, path: tail.slice(ref.length + 1) });
      }
    }
  }
  if (candidates.length !== 1) throw new ForgeError({ code: 'FORGE_AMBIGUOUS', message: 'The URL does not resolve to exactly one branch/tag and path. Use a commit-pinned blob URL.' });
  const target = candidates[0]!;
  let path = requirePath(target.path);
  if (url.hash) {
    const lines = /^#L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(url.hash);
    if (!lines) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Only exact GitHub line anchors are supported on blob URLs.' });
    path += `:${lines[1]}-${lines[2] ?? lines[1]}`;
  }
  return { repo, at: target.ref, paths: [path] };
}
