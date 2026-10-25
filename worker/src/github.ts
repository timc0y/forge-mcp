/**
 * The GitHub request boundary. Every operation carries the human's GitHub App
 * user token, whose permissions are the intersection of App and human grants.
 * Installation-wide tokens must never authorize operations on a user's behalf.
 * Statuses are shaped by callers; network failures are explicit Forge errors.
 */
import type { GitHubRequest, RepoRef } from './contracts';
import type { Env } from './env';
import { ForgeError, isForgeError } from './errors';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const USER_AGENT = 'Forge-MCP';

/** A raw diff is not JSON and is not an error; it is the body the caller asked for. */
function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Read a body, stopping the moment it passes `maxBytes` rather than after. The
 * whole point of the bound is that a repository too large to read must cost a
 * cancelled stream, not the memory to hold it first.
 *
 * Returns null when the body is refused for size.
 */
async function readBounded(response: Response, maxBytes?: number): Promise<ArrayBuffer | null> {
  if (!maxBytes || !response.body) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function requester(token: string): GitHubRequest {
  return async (path, init) => {
    const headers = new Headers({
      accept: init?.accept ?? 'application/vnd.github+json',
      'user-agent': USER_AGENT,
      'x-github-api-version': API_VERSION,
      authorization: `Bearer ${token}`
    });
    const body = init?.body === undefined ? undefined : JSON.stringify(init.body);
    if (body !== undefined) headers.set('content-type', 'application/json');

    let response: Response;
    let text = '';
    let bytes: ArrayBuffer | undefined;
    try {
      // `cache: 'no-store'` is load-bearing, not defensive noise. GitHub sends
      // `Cache-Control: private, max-age=60, s-maxage=60` on reads, and a
      // Workers subrequest can be answered from the edge cache under it: a ref
      // that was deleted and recreated was served at its pre-deletion value,
      // which made an approval refuse itself as "moved". Forge reads GitHub to
      // decide what is true now, so it must never read a cached answer.
      response = await fetch(`${API_BASE}${path}`, {
        method: init?.method ?? 'GET',
        headers,
        body,
        cache: 'no-store',
        signal: init?.signal
      });
      if (init?.stream && response.ok && response.body) {
        const limit = init.maxBytes ?? 20 * 1024 * 1024;
        let seen = 0;
        const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            seen += chunk.byteLength;
            if (seen > limit) throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: 'GitHub response exceeded its streaming byte limit.' });
            controller.enqueue(chunk);
          }
        }));
        return { status: response.status, json: null, text: '', stream, headers: response.headers };
      }
      if (init?.raw) {
        const read = await readBounded(response, init.maxBytes);
        if (read === null) {
          // Refused, not failed: the caller asked for a bound and this body is
          // past it. 413 keeps that distinct from an unreadable body.
          return { status: 413, json: null, text: '', bytes: undefined, headers: response.headers };
        }
        bytes = read;
      } else {
        const buffer = await readBounded(response, init?.maxBytes ?? 8 * 1024 * 1024);
        if (buffer === null) return { status: 413, json: null, text: '', headers: response.headers };
        text = new TextDecoder().decode(buffer);
      }
    } catch (error) {
      if (isForgeError(error)) throw error;
      throw new ForgeError({
        code: 'FORGE_UPSTREAM_UNAVAILABLE',
        message: `GitHub could not be reached (${init?.method ?? 'GET'} ${path}).`,
        retryable: true
      });
    }
    return { status: response.status, json: parseJson(text), text, bytes, headers: response.headers };
  };
}

/**
 * Authenticated as the human, for all repository and account operations.
 * Never cached here: the stored/rotating credential lifecycle lives in
 * user-token.ts.
 */
export async function githubUserRequest(_env: Env, userAccessToken: string): Promise<GitHubRequest> {
  return requester(userAccessToken);
}

// GitHub's own limits: an owner is up to 39 alphanumerics and inner hyphens; a
// repository name is up to 100 of alphanumeric, dot, dash and underscore.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function parseRepo(value: string): RepoRef {
  const parts = value.trim().split('/').map((part) => part.trim());
  // An absent half becomes '', which fails the pattern rather than being guessed at.
  const owner = parts[0] ?? '';
  const name = parts[1] ?? '';
  // `.` and `..` match the name pattern but are paths, not repositories.
  if (parts.length !== 2 || !OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `"${value.trim()}" is not a repository. Give it as owner/name, for example octocat/hello-world.`,
      details: { value }
    });
  }
  return { owner, name };
}
