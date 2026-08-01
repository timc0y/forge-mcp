import { describe, expect, it } from 'vitest';
import {
  commitFilesToBranch,
  createBranchRef,
  RemoteCommitConflict,
  type GitHubRequest
} from '../../packages/git-github/src/remote-commit';

/**
 * A fake GitHub that owns a branch head and lets a test move it mid-flight,
 * which is the only way to exercise the non-fast-forward path honestly.
 */
function fakeGitHub(options: {
  head: string;
  treeOf: Record<string, string>;
  /** Called before each ref update; return a new head to simulate a race. */
  onRefUpdate?: (attempt: number) => string | undefined;
  compareFiles?: string[];
  blobs?: Record<string, string>;
  branchMissingUntilCreated?: boolean;
  /** Simulates GitHub's own `truncated: true` on a tree too large to return in full. */
  treeTruncated?: boolean;
  /** Return a different SHA on the first read after a successful update. */
  readBackSha?: string;
} ) {
  let head = options.head;
  const treeOf = { ...options.treeOf };
  let refUpdates = 0;
  const calls: string[] = [];
  let treeSeq = 0;
  let created = false;
  let verifyNextRead = false;

  const request: GitHubRequest = async (path, init) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);

    if (method === 'GET' && path.includes('/git/ref/heads/')) {
      if (options.branchMissingUntilCreated && !created) return { status: 404, json: {} };
      if (verifyNextRead && options.readBackSha) {
        verifyNextRead = false;
        return { status: 200, json: { object: { sha: options.readBackSha } } };
      }
      return { status: 200, json: { object: { sha: head } } };
    }
    if (method === 'POST' && path.endsWith('/git/refs')) {
      created = true;
      head = (init!.body as { sha: string }).sha;
      return { status: 201, json: {} };
    }
    if (method === 'GET' && path.includes('/git/trees/') && path.includes('recursive=1')) {
      return {
        status: 200,
        json: {
          tree: Object.entries(options.blobs ?? {}).map(([p, sha]) => ({ path: p, sha, type: 'blob' })),
          ...(options.treeTruncated ? { truncated: true } : {})
        }
      };
    }
    if (method === 'GET' && path.includes('/git/commits/')) {
      const sha = path.split('/').pop()!;
      return { status: 200, json: { tree: { sha: treeOf[sha] ?? `tree-of-${sha}` } } };
    }
    if (method === 'GET' && path.includes('/compare/')) {
      return { status: 200, json: { files: (options.compareFiles ?? []).map((filename) => ({ filename })) } };
    }
    if (method === 'POST' && path.endsWith('/git/blobs')) {
      const body = init!.body as { content: string };
      return { status: 201, json: { sha: `blob-${body.content.length}` } };
    }
    if (method === 'POST' && path.endsWith('/git/trees')) {
      const body = init!.body as { base_tree: string };
      // A distinct tree each time unless the test wants "no change".
      treeSeq += 1;
      return { status: 201, json: { sha: options.treeOf.__unchanged__ ? body.base_tree : `newtree-${treeSeq}` } };
    }
    if (method === 'POST' && path.endsWith('/git/commits')) {
      return { status: 201, json: { sha: `commit-${treeSeq}` } };
    }
    if (method === 'PATCH' && path.includes('/git/refs/heads/')) {
      refUpdates += 1;
      const moved = options.onRefUpdate?.(refUpdates);
      if (moved) {
        head = moved;
        return { status: 422, json: {} };
      }
      head = (init!.body as { sha: string }).sha;
      verifyNextRead = true;
      return { status: 200, json: { object: { sha: head } } };
    }
    return { status: 404, json: {} };
  };

  return { request, calls, get head() { return head; }, get refUpdates() { return refUpdates; }, get created() { return created; } };
}

const file = { path: 'src/a.ts', content: 'export const a = 1;\n' };

describe('commitFilesToBranch', () => {
  it('commits to the remote and fast-forwards the branch', async () => {
    const gh = fakeGitHub({ head: 'head1', treeOf: { head1: 'tree1' } });

    const result = await commitFilesToBranch(gh.request, {
      owner: 'acme', repo: 'app', branch: 'forge/x', message: 'edit', files: [file]
    });

    expect(result.unchanged).toBe(false);
    expect(result.commitSha).toBe('commit-1');
    expect(result.parentSha).toBe('head1');
    expect(result.attempts).toBe(1);
    expect(result.remoteSha).toBe('commit-1');
    expect(result.pushVerified).toBe(true);
    expect(gh.head).toBe('commit-1');
    // Fast-forward only — never force. Forcing is how concurrent work vanishes.
    expect(gh.calls.some((c) => c.startsWith('PATCH'))).toBe(true);
  });

  it('creates no commit when the tree is identical', async () => {
    // Writing the content a file already has is not work, and an empty commit
    // would look like it was.
    const gh = fakeGitHub({ head: 'head1', treeOf: { head1: 'tree1', __unchanged__: 'yes' } });

    const result = await commitFilesToBranch(gh.request, {
      owner: 'acme', repo: 'app', branch: 'forge/x', message: 'edit', files: [file]
    });

    expect(result.unchanged).toBe(true);
    expect(result.commitSha).toBeUndefined();
    expect(gh.calls.some((c) => c.endsWith('/git/commits') && c.startsWith('POST'))).toBe(false);
  });

  it('re-applies onto the new head when the branch moves under it', async () => {
    // Non-fast-forward on the first update, then success. The agent should
    // never see this — it is Forge's job, not something to reason about.
    const gh = fakeGitHub({
      head: 'head1',
      treeOf: { head1: 'tree1', head2: 'tree2' },
      onRefUpdate: (attempt) => (attempt === 1 ? 'head2' : undefined),
      compareFiles: ['docs/unrelated.md']
    });

    const result = await commitFilesToBranch(gh.request, {
      owner: 'acme', repo: 'app', branch: 'forge/x', message: 'edit', files: [file]
    });

    expect(result.rebased).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.parentSha).toBe('head2');
    expect(gh.refUpdates).toBe(2);
  });

  it('refuses to overwrite a path the concurrent commit also changed', async () => {
    const gh = fakeGitHub({
      head: 'head1',
      treeOf: { head1: 'tree1', head2: 'tree2' },
      onRefUpdate: (attempt) => (attempt === 1 ? 'head2' : undefined),
      compareFiles: ['src/a.ts']
    });

    await expect(
      commitFilesToBranch(gh.request, {
        owner: 'acme', repo: 'app', branch: 'forge/x', message: 'edit', files: [file]
      })
    ).rejects.toBeInstanceOf(RemoteCommitConflict);
  });

  it('gives up after the retry bound rather than looping', async () => {
    const gh = fakeGitHub({
      head: 'head1',
      treeOf: { head1: 'tree1' },
      onRefUpdate: (attempt) => `head-${attempt + 1}`,
      compareFiles: []
    });

    await expect(
      commitFilesToBranch(gh.request, {
        owner: 'acme', repo: 'app', branch: 'forge/x', message: 'edit', files: [file], maxAttempts: 2
      })
    ).rejects.toThrow(/moved during 2 attempts.*Nothing was committed/u);
  });

  it('does not retry a failure that is not a non-fast-forward', async () => {
    const request: GitHubRequest = async (path, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && path.includes('/git/ref/heads/')) return { status: 200, json: { object: { sha: 'h' } } };
      if (method === 'GET' && path.includes('/git/commits/')) return { status: 200, json: { tree: { sha: 't' } } };
      if (method === 'POST' && path.endsWith('/git/blobs')) return { status: 201, json: { sha: 'b' } };
      if (method === 'POST' && path.endsWith('/git/trees')) return { status: 201, json: { sha: 'newtree' } };
      if (method === 'POST' && path.endsWith('/git/commits')) return { status: 201, json: { sha: 'c' } };
      return { status: 403, json: {} };
    };

    await expect(
      commitFilesToBranch(request, { owner: 'a', repo: 'b', branch: 'forge/x', message: 'm', files: [file] })
    ).rejects.toThrow(/HTTP 403/u);
  });

  it('fails closed when the updated ref does not read back at the new commit', async () => {
    const gh = fakeGitHub({ head: 'head1', treeOf: { head1: 'tree1' }, readBackSha: 'someone-else' });

    await expect(
      commitFilesToBranch(gh.request, {
        owner: 'acme', repo: 'app', branch: 'forge/x', message: 'edit', files: [file]
      })
    ).rejects.toThrow(/could not be verified.*someone-else.*commit-1/u);
  });

  it('deletes a path when content is null', async () => {
    const gh = fakeGitHub({ head: 'head1', treeOf: { head1: 'tree1' } });
    let treeBody: { tree: Array<{ path: string; sha: string | null }> } | undefined;
    const request: GitHubRequest = async (path, init) => {
      if ((init?.method ?? 'GET') === 'POST' && path.endsWith('/git/trees')) {
        treeBody = init!.body as typeof treeBody;
      }
      return gh.request(path, init);
    };

    await commitFilesToBranch(request, {
      owner: 'acme', repo: 'app', branch: 'forge/x', message: 'rm', files: [{ path: 'gone.ts', content: null }]
    });

    expect(treeBody?.tree[0]).toMatchObject({ path: 'gone.ts', sha: null });
  });
});

describe('stale-read protection', () => {
  it('refuses to overwrite a file that changed since the agent read it', async () => {
    // The silent-revert case: the agent read at one version, the branch moved
    // before the edit even started, and a whole-file write would quietly undo
    // the other change. The retry-time check cannot see this — only what the
    // reader actually saw can.
    const gh = fakeGitHub({ head: 'head1', treeOf: { head1: 'tree1' }, blobs: { 'src/a.ts': 'blob-current' } });

    await expect(
      commitFilesToBranch(gh.request, {
        owner: 'acme', repo: 'app', branch: 'forge/x', message: 'edit', files: [file],
        expectedBlobs: { 'src/a.ts': 'blob-the-agent-read' }
      })
    ).rejects.toThrow(/changed on the branch since they were last read/u);
  });

  it('allows the write when what the agent read is still current', async () => {
    const gh = fakeGitHub({ head: 'head1', treeOf: { head1: 'tree1' }, blobs: { 'src/a.ts': 'blob-same' } });

    const result = await commitFilesToBranch(gh.request, {
      owner: 'acme', repo: 'app', branch: 'forge/x', message: 'edit', files: [file],
      expectedBlobs: { 'src/a.ts': 'blob-same' }
    });

    expect(result.commitSha).toBeDefined();
  });

  it('allows a new file, which the agent could not have read', async () => {
    const gh = fakeGitHub({ head: 'head1', treeOf: { head1: 'tree1' }, blobs: {} });

    const result = await commitFilesToBranch(gh.request, {
      owner: 'acme', repo: 'app', branch: 'forge/x', message: 'new', files: [file],
      expectedBlobs: { 'src/a.ts': 'blob-stale-but-path-is-gone' }
    });

    expect(result.commitSha).toBeDefined();
  });
});

describe('a truncated tree read fails closed instead of open', () => {
  // GitHub sets `truncated: true` on git/trees?recursive=1 for very large
  // trees and silently omits entries past that point. Before this guard, a
  // path missing from `current` was read as "new file, allow" unconditionally
  // — indistinguishable from "this path exists but the listing cut it off".
  // On a repository large enough to trip GitHub's limit, that let the
  // read-before-overwrite guard silently stop guarding, which is the worst
  // direction for a guard to fail in.

  it('refuses requireKnownBase when the written path is missing from a truncated tree', async () => {
    // Without the fix this is indistinguishable from "brand new file" and
    // would be allowed — the exact fail-open case.
    const gh = fakeGitHub({ head: 'head1', treeOf: { head1: 'tree1' }, blobs: {}, treeTruncated: true });

    await expect(
      commitFilesToBranch(gh.request, {
        owner: 'acme', repo: 'app', branch: 'forge/x', message: 'edit',
        files: [file], requireKnownBase: true
      })
    ).rejects.toThrow(/too large to return in full/u);
  });

  it('refuses an expectedBlobs write when the written path is missing from a truncated tree', async () => {
    const gh = fakeGitHub({ head: 'head1', treeOf: { head1: 'tree1' }, blobs: {}, treeTruncated: true });

    await expect(
      commitFilesToBranch(gh.request, {
        owner: 'acme', repo: 'app', branch: 'forge/x', message: 'edit', files: [file],
        expectedBlobs: { 'src/a.ts': 'blob-the-agent-read' }
      })
    ).rejects.toThrow(/too large to return in full/u);
  });

  it('still allows the write when a truncated tree happens to include the touched path', async () => {
    // The path is provably present and unchanged, so truncation elsewhere in
    // the tree has nothing to do with this write.
    const gh = fakeGitHub({
      head: 'head1', treeOf: { head1: 'tree1' }, blobs: { 'src/a.ts': 'blob-same' }, treeTruncated: true
    });

    const result = await commitFilesToBranch(gh.request, {
      owner: 'acme', repo: 'app', branch: 'forge/x', message: 'edit', files: [file],
      expectedBlobs: { 'src/a.ts': 'blob-same' }
    });

    expect(result.commitSha).toBeDefined();
  });

  it('does not misfire when the tree is complete (truncated: false / absent)', async () => {
    // Regression guard: an untruncated tree must keep allowing genuinely new
    // files, same as before this change.
    const gh = fakeGitHub({ head: 'head1', treeOf: { head1: 'tree1' }, blobs: {} });

    const result = await commitFilesToBranch(gh.request, {
      owner: 'acme', repo: 'app', branch: 'forge/x', message: 'new', files: [file],
      requireKnownBase: true
    });

    expect(result.commitSha).toBeDefined();
  });
});

describe('a branch GitHub has never seen', () => {
  // Most agent branches exist on GitHub before any edit — forge_start (or
  // forge_workspace_create adopting a pre-created ref) creates them up front.
  // A branch can still be opened without that cut (forge_workspace_create on
  // the default ref), so the first edit still targets a ref GitHub has never
  // heard of. Without this the whole remote-first path fails on call one.
  it('creates the ref from the base commit instead of 404ing', async () => {
    const gh = fakeGitHub({ head: 'base-sha', treeOf: { 'base-sha': 'tree0' }, branchMissingUntilCreated: true });

    const result = await commitFilesToBranch(gh.request, {
      owner: 'acme', repo: 'app', branch: 'forge/new', message: 'first edit',
      files: [file], baseSha: 'base-sha'
    });

    expect(gh.created).toBe(true);
    expect(result.commitSha).toBeDefined();
    expect(gh.calls.some((c) => c === 'POST /repos/acme/app/git/refs')).toBe(true);
  });

  it('says so plainly when there is no base to create it from', async () => {
    const gh = fakeGitHub({ head: 'x', treeOf: {}, branchMissingUntilCreated: true });
    await expect(
      commitFilesToBranch(gh.request, { owner: 'a', repo: 'b', branch: 'forge/new', message: 'm', files: [file] })
    ).rejects.toThrow(/does not exist on GitHub and no base commit/u);
  });
});

describe('createBranchRef', () => {
  // This is the one function that ever mints a branch ref on GitHub —
  // forge_start calls it directly, before any container exists, and
  // commitFilesToBranch's retry loop calls it too when it hits a 404 on a
  // branch that was cut locally instead. One function, one behaviour, either
  // way.
  it('creates the ref at the given base commit', async () => {
    const calls: string[] = [];
    const request: GitHubRequest = async (path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      return init?.method === 'POST'
        ? { status: 201, json: {} }
        : { status: 200, json: { object: { sha: 'base-sha' } } };
    };

    const result = await createBranchRef(request, {
      owner: 'acme', repo: 'app', branch: 'forge/new-task', baseSha: 'base-sha'
    });

    expect(result.created).toBe(true);
    expect(calls).toEqual([
      'POST /repos/acme/app/git/refs',
      'GET /repos/acme/app/git/ref/heads/forge/new-task'
    ]);
  });

  it('tolerates a concurrent creation only when the ref matches the requested base', async () => {
    // 422 means someone else — another call, another retry — created the same
    // ref between our read and our write. That is a race resolved in our
    // favour already, not a failure to surface.
    let calls = 0;
    const request: GitHubRequest = async () => {
      calls += 1;
      return calls === 1
        ? { status: 422, json: { message: 'Reference already exists' } }
        : { status: 200, json: { object: { sha: 'base-sha' } } };
    };

    const result = await createBranchRef(request, {
      owner: 'acme', repo: 'app', branch: 'forge/new-task', baseSha: 'base-sha'
    });

    expect(result.created).toBe(false);
  });

  it('rejects a 422 when a colliding ref points at a different commit', async () => {
    let calls = 0;
    const request: GitHubRequest = async () => {
      calls += 1;
      return calls === 1
        ? { status: 422, json: { message: 'Reference already exists' } }
        : { status: 200, json: { object: { sha: 'unrelated-sha' } } };
    };

    await expect(
      createBranchRef(request, {
        owner: 'acme', repo: 'app', branch: 'forge/new-task', baseSha: 'base-sha'
      })
    ).rejects.toThrow(/existing ref points at unrelated-sha.*base-sha/u);
  });

  it('rejects an unrelated 422 whose ref cannot be verified', async () => {
    const request: GitHubRequest = async () => ({ status: 422, json: { message: 'Invalid request' } });

    await expect(
      createBranchRef(request, {
        owner: 'acme', repo: 'app', branch: 'forge/new-task', baseSha: 'base-sha'
      })
    ).rejects.toThrow(/failed validation.*422.*Invalid request/u);
  });

  it('rejects a non-collision 422 without attempting to adopt an existing ref', async () => {
    let calls = 0;
    const request: GitHubRequest = async () => {
      calls += 1;
      return calls === 1
        ? { status: 422, json: { message: 'Object does not exist' } }
        : { status: 200, json: { object: { sha: 'base-sha' } } };
    };
    await expect(
      createBranchRef(request, {
        owner: 'acme', repo: 'app', branch: 'forge/new-task', baseSha: 'base-sha'
      })
    ).rejects.toThrow(/Object does not exist/u);
    expect(calls).toBe(1);
  });

  it('throws on any other failure', async () => {
    const request: GitHubRequest = async () => ({ status: 403, json: {} });

    await expect(
      createBranchRef(request, { owner: 'acme', repo: 'app', branch: 'forge/new-task', baseSha: 'base-sha' })
    ).rejects.toThrow(/HTTP 403/u);
  });
});

describe('unread files are not overwritable', () => {
  it('refuses to replace an existing file the session never read', async () => {
    // expectedBlobs only guards paths that happen to have been read, so a
    // dropped session would silently downgrade it to no protection at all.
    // Not having read a file has to be disqualifying by itself.
    const gh = fakeGitHub({ head: 'head1', treeOf: { head1: 'tree1' }, blobs: { 'src/a.ts': 'blob-current' } });

    await expect(
      commitFilesToBranch(gh.request, {
        owner: 'acme', repo: 'app', branch: 'forge/x', message: 'edit',
        files: [file], requireKnownBase: true
      })
    ).rejects.toThrow(/have not been read in this session/u);
  });

  it('still allows creating a file that does not exist', async () => {
    const gh = fakeGitHub({ head: 'head1', treeOf: { head1: 'tree1' }, blobs: {} });

    const result = await commitFilesToBranch(gh.request, {
      owner: 'acme', repo: 'app', branch: 'forge/x', message: 'new',
      files: [file], requireKnownBase: true
    });

    expect(result.commitSha).toBeDefined();
  });

  it('does not apply the rule to machine-generated writes', async () => {
    // A formatter reports what a file already became; it is not claiming to
    // have read it first.
    const gh = fakeGitHub({ head: 'head1', treeOf: { head1: 'tree1' }, blobs: { 'src/a.ts': 'blob-current' } });

    const result = await commitFilesToBranch(gh.request, {
      owner: 'acme', repo: 'app', branch: 'forge/x', message: 'format', files: [file]
    });

    expect(result.commitSha).toBeDefined();
  });
});
