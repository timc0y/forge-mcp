import type { GitHubRequest } from '@forge/git-github';

export interface GitHubContentBlob {
  content?: string;
  sha?: string;
  encoding?: string;
}

export type FragmentSourceResult =
  | { ok: true; body: GitHubContentBlob; sourceRef: string; branchMissing: boolean }
  | { ok: false; kind: 'file_missing'; sourceRef: string; branchMissing: boolean }
  | { ok: false; kind: 'base_unavailable'; branchMissing: true }
  | { ok: false; kind: 'provider'; status: number; operation: 'content' | 'ref'; sourceRef: string };

function encodedPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function encodedRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

/** Resolve fragment input against the feature ref, or its exact local-branch base. */
export async function readFragmentSource(
  request: GitHubRequest,
  input: { base: string; branch: string; baseSha?: string; path: string }
): Promise<FragmentSourceResult> {
  const contentPath = `${input.base}/contents/${encodedPath(input.path)}`;
  const branchRead = await request(`${contentPath}?ref=${encodeURIComponent(input.branch)}`);
  if (branchRead.status === 200) {
    return { ok: true, body: branchRead.json as GitHubContentBlob, sourceRef: input.branch, branchMissing: false };
  }
  if (branchRead.status !== 404) {
    return { ok: false, kind: 'provider', status: branchRead.status, operation: 'content', sourceRef: input.branch };
  }

  const refRead = await request(`${input.base}/git/ref/heads/${encodedRef(input.branch)}`);
  if (refRead.status === 200) {
    return { ok: false, kind: 'file_missing', sourceRef: input.branch, branchMissing: false };
  }
  if (refRead.status !== 404) {
    return { ok: false, kind: 'provider', status: refRead.status, operation: 'ref', sourceRef: input.branch };
  }
  if (!input.baseSha) return { ok: false, kind: 'base_unavailable', branchMissing: true };

  const baseRead = await request(`${contentPath}?ref=${encodeURIComponent(input.baseSha)}`);
  if (baseRead.status === 200) {
    return { ok: true, body: baseRead.json as GitHubContentBlob, sourceRef: input.baseSha, branchMissing: true };
  }
  if (baseRead.status === 404) {
    return { ok: false, kind: 'file_missing', sourceRef: input.baseSha, branchMissing: true };
  }
  return { ok: false, kind: 'provider', status: baseRead.status, operation: 'content', sourceRef: input.baseSha };
}
