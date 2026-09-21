import type { GitHubRequest, RepoRef } from './contracts';
import { formatRepo } from './contracts';
import { ForgeError } from './errors';
import { CONTEXT_LIMITS, RequestBudget, requirePath, requireSha, utf8Bytes, type SourceIdentity } from './evidence';
import { readTree } from './read';

export interface SourceFile { path: string; text: string; blob: string; bytes: number }
export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function githubFailure(status: number, operation: string): never {
  throw new ForgeError({
    code: status === 401 || status === 403 ? 'FORGE_AUTH_REQUIRED' : 'FORGE_UPSTREAM_UNAVAILABLE',
    message: `GitHub could not provide ${operation} (HTTP ${status}). Missing access is not evidence of absence.`,
    retryable: status === 429 || status >= 500
  });
}
export async function resolveCommit(gh: GitHubRequest, repo: RepoRef, ref: string): Promise<string> {
  if (!ref || ref.length > 256 || /[\u0000-\u0020]/.test(ref)) {
    throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'The requested Git revision is invalid.' });
  }
  const response = await gh(`/repos/${formatRepo(repo)}/commits/${encodeURIComponent(ref)}`);
  if (response.status !== 200) githubFailure(response.status, 'the requested revision');
  const sha = object(response.json)?.sha;
  if (typeof sha !== 'string') githubFailure(502, 'an immutable revision identity');
  return requireSha(sha);
}

/** One authorized request, one revision, no repository state retained between calls. */
export class Snapshot {
  readonly files = new Map<string, Promise<SourceFile>>();
  private constructor(
    readonly gh: GitHubRequest,
    readonly repo: RepoRef,
    readonly identity: SourceIdentity,
    readonly branch: string,
    readonly budget: RequestBudget
  ) {}
  static async open(request: GitHubRequest, repo: RepoRef, ref?: string, budget = new RequestBudget()): Promise<Snapshot> {
    const memo = new Map<string, Promise<Awaited<ReturnType<GitHubRequest>>>>();
    const gh: GitHubRequest = (path, init) => {
      budget.assert();
      const reusable = (!init?.method || init.method === 'GET') && !init?.raw && !init?.stream;
      const key = JSON.stringify([path, init?.accept]);
      const cached = reusable ? memo.get(key) : undefined;
      if (cached) return cached;
      budget.github();
      const pending = request(path, { ...init, signal: AbortSignal.timeout(budget.remaining()) });
      if (reusable) memo.set(key, pending);
      return pending;
    };
    const metadata = await gh(`/repos/${formatRepo(repo)}`);
    if (metadata.status !== 200) githubFailure(metadata.status, 'repository metadata');
    const value = object(metadata.json);
    if (typeof value?.default_branch !== 'string' || typeof value.private !== 'boolean') {
      githubFailure(502, 'repository revision and privacy metadata');
    }
    const requested = ref ?? value.default_branch;
    const sha = await resolveCommit(gh, repo, requested);
    return new Snapshot(gh, repo, { repo: formatRepo(repo), requested, sha, private: value.private }, value.default_branch, budget);
  }
  async tree(): Promise<Awaited<ReturnType<typeof readTree>>> {
    return readTree(this.gh, this.repo, this.identity.sha);
  }
  file(path: string): Promise<SourceFile> {
    requirePath(path);
    const cached = this.files.get(path);
    if (cached) return cached;
    const pending = this.readFile(path);
    this.files.set(path, pending);
    return pending;
  }
  private async readFile(path: string): Promise<SourceFile> {
    const response = await this.gh(`/repos/${formatRepo(this.repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${this.identity.sha}`, { maxBytes: 2 * CONTEXT_LIMITS.sourceBytes });
    if (response.status !== 200) githubFailure(response.status, `source ${path} at the pinned revision`);
    const body = object(response.json);
    if (body?.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string' || typeof body.sha !== 'string' || typeof body.size !== 'number') {
      throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: `${path} is not an inline-readable regular source file. No alternate file was substituted.` });
    }
    if (body.size > CONTEXT_LIMITS.sourceBytes || body.content.length > Math.ceil(CONTEXT_LIMITS.sourceBytes * 1.5)) {
      throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: `${path} exceeds the exact-source byte limit.` });
    }
    let text: string;
    try {
      const binary = atob(body.content.replace(/\s/g, ''));
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      if (bytes.includes(0)) throw new Error('binary');
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: `${path} is not valid UTF-8 source.` });
    }
    const bytes = utf8Bytes(text);
    this.budget.keep(bytes);
    this.budget.downloaded += bytes;
    return { path, text, blob: requireSha(body.sha), bytes };
  }
}
