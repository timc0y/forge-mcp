import type { GitHubRequest, RepoRef } from './contracts';
import { formatRepo } from './contracts';
import { ForgeError, toForgeError } from './errors';

const ZERO_OID = '0'.repeat(40);
const UPDATE_REFS = 'mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }';
type Options = { signal?: AbortSignal };

/** GitHub checks beforeOid atomically; force:false alone does not check it.
 * https://docs.github.com/en/graphql/reference/git#updaterefs
 * No retries: an unconfirmed dispatch must be inspected by the caller.
 */
export async function updateRefIfUnchanged(
  gh: GitHubRequest, repo: RepoRef, branch: string, beforeSha: string, afterSha: string, options?: Options
): Promise<void> {
  await changeRef(gh, repo, branch, beforeSha, afterSha, options);
}

/** A zero afterOid deletes only the exact beforeOid, through the same user gh. */
export async function deleteRefIfUnchanged(
  gh: GitHubRequest, repo: RepoRef, branch: string, beforeSha: string, options?: Options
): Promise<void> {
  await changeRef(gh, repo, branch, beforeSha, ZERO_OID, options);
}

async function changeRef(
  gh: GitHubRequest, repo: RepoRef, branch: string, beforeSha: string, afterSha: string, options?: Options
): Promise<void> {
  const deleting = afterSha === ZERO_OID;
  const url = `https://github.com/${formatRepo(repo)}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
  const sha = deleting ? beforeSha : afterSha;
  const candidate = `https://github.com/${formatRepo(repo)}/commit/${sha}`;
  const details = { branch, beforeSha, sha, url: candidate, branchUrl: url };
  const uncertain = (): ForgeError => new ForgeError({
    code: 'FORGE_UPSTREAM_UNAVAILABLE', retryable: false,
    message: `GitHub did not confirm the ${deleting ? 'deletion' : 'update'} of ${branch}; it may have taken effect. ${deleting ? 'Reviewed' : 'Candidate'} commit: ${candidate}. Inspect ${url} before another write.`,
    details: { ...details, refUpdate: 'uncertain' }
  });

  let repositoryId: string;
  try {
    const response = await withSignal(() => gh(`/repos/${formatRepo(repo)}`, { signal: options?.signal }), options?.signal);
    if (response.status !== 200 || !record(response.json) || typeof response.json.node_id !== 'string' || !response.json.node_id) {
      throw new ForgeError({
        code: response.status === 401 || response.status === 403 ? 'FORGE_AUTH_REQUIRED' : response.status === 404 ? 'FORGE_NOT_FOUND' : 'FORGE_UPSTREAM_UNAVAILABLE',
        message: `GitHub did not return the repository identity for ${formatRepo(repo)} (status ${response.status}). No ref update was dispatched.`,
        retryable: response.status >= 500
      });
    }
    repositoryId = response.json.node_id;
    options?.signal?.throwIfAborted();
  } catch (thrown) {
    const error = toForgeError(thrown);
    throw new ForgeError({ code: error.code, message: error.message, retryable: error.retryable, details: { ...error.details, ...details, refUpdate: 'not_dispatched' } });
  }

  let response: Awaited<ReturnType<GitHubRequest>>;
  try {
    response = await withSignal(() => gh('/graphql', {
      method: 'POST', signal: options?.signal,
      body: { query: UPDATE_REFS, variables: { input: { repositoryId, refUpdates: [{ name: `refs/heads/${branch}`, beforeOid: beforeSha, afterOid: afterSha, force: false }] } } }
    }), options?.signal);
  } catch (thrown) {
    if (thrown instanceof ForgeError && thrown.details?.refUpdate === 'not_dispatched') {
      throw new ForgeError({ code: thrown.code, message: thrown.message, retryable: thrown.retryable, details: { ...thrown.details, ...details, refUpdate: 'not_dispatched' } });
    }
    throw uncertain();
  }

  const body = record(response.json) ? response.json : null;
  const data = record(body?.data) ? body.data : null;
  // The input omits clientMutationId, so only its exact null echo confirms it.
  if (response.status === 200 && record(data?.updateRefs) && data.updateRefs.clientMutationId === null &&
    (body?.errors === undefined || (Array.isArray(body.errors) && body.errors.length === 0))) return;

  // Only explicit client/auth/validation refusals establish that this mutation
  // did not run. Internal GraphQL errors can arrive after a side effect.
  const errors = body?.errors;
  const rejected = response.status === 200 && data?.updateRefs === null && Array.isArray(errors) && errors.length > 0 && errors.every((error) =>
    record(error) && ['UNPROCESSABLE', 'FORBIDDEN', 'NOT_FOUND'].includes(String(error.type)) &&
    Array.isArray(error.path) && error.path.length === 1 && error.path[0] === 'updateRefs'
  );
  if (rejected || [401, 403, 404, 422].includes(response.status)) {
    const forbidden = response.status === 401 || response.status === 403 || (rejected && errors.some((error) => record(error) && error.type === 'FORBIDDEN'));
    const missing = response.status === 404 || (rejected && errors.some((error) => record(error) && error.type === 'NOT_FOUND'));
    throw new ForgeError({
      code: forbidden ? 'FORGE_AUTH_REQUIRED' : missing ? 'FORGE_NOT_FOUND' : 'FORGE_CONFLICT', retryable: false,
      message: `GitHub rejected the ${deleting ? 'deletion' : 'update'} of ${branch}. Inspect ${url} before writing again.`,
      details: { ...details, refUpdate: 'rejected', status: response.status }
    });
  }
  throw uncertain();
}

/** Bound callbacks that ignore abort, and never dispatch after cancellation. */
async function withSignal<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return run();
  let abort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error('GitHub request aborted'));
      signal.addEventListener('abort', abort, { once: true });
    });
    return await Promise.race([run(), cancelled]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
