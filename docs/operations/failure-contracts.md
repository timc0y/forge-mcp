# Failure contracts

Reproduced failures from running Forge against its own repository, and the
tool-level contract each one is now held to. The point of writing them as
contracts rather than advice: an agent cannot be relied on to remember a rule,
but it will read a field on every call.

## The governing rule

**Local editing and remote persistence are separate outcomes and are reported
separately.**

A mutating tool returns as soon as the edit is committed and checkpointed. The
push is a distinct, separately recoverable step. A push failure never erases
the fact that the edit landed, and a successful edit never implies the work is
on GitHub.

Two fields carry this on every mutating call:

| field | question it answers |
| --- | --- |
| `mutationOutcome` | Did my edit land? `unchanged` \| `workspace_changed` \| `committed_local` \| `pushed_remote` \| `unknown` |
| `durability` | Does it survive the workspace? `local_only` \| `remote_branch` \| `pull_request` \| `failed_recovered` |

`on_remote` is true only after a real remote read-back (`git ls-remote`
matching HEAD). A push command's exit code is not sufficient.

## Contracts

### 1. A push failure must not report the edit as failed

**Was:** the post-commit auto-push threw out of the *write* tool. The write and
the commit had both succeeded, so the agent was told its write failed and
retried the write instead of the push.

**Now:** the push outcome is data, not an exception. `mutationOutcome:
'committed_local'` plus an explicit "your edit IS committed — do NOT repeat
it" steer.

### 2. A failed push must not strand the commit

**Was:** a push was only attempted when *that call* produced a commit. A retry
whose commit was a no-op skipped the push, so the first failed push stranded
that commit permanently.

**Now:** reconciliation keys off `hasUnpushedWork`, so every later mutation
re-attempts the push until origin actually has the work.

### 3. "Nothing to commit" is not a failure

**Was:** `FORGE_GIT_DIRTY: Forge could not create the commit` — a second,
misleading fault invented on exactly the retry path above.

**Now:** `{ committed: false, reason: 'nothing to commit' }`, surfacing as
`mutationOutcome: 'unchanged'`. Genuine commit failures still throw.

### 4. A missing remote branch is not a matching one

**Was:** `diverged: false` covered both "the remote agrees" and "there is no
remote branch at all", and both reported *"Local HEAD matches the remote
feature branch."* — describing a branch that had never reached GitHub as
matching it.

**Now:** explicit `remoteState`: `missing` \| `matching` \| `diverged` \|
`not_applicable`. `missing` states plainly that the work is local only.

### 5. Errors must survive the RPC boundary

**Was:** a `ForgeError` thrown inside a Durable Object arrived as a plain
object — every field intact, `instanceof` false — and was flattened into
`FORGE_INTERNAL_ERROR`. A rejected patch and a stale revision became the same
opaque "Forge could not complete the operation", and the agent retried blind.

**Now:** serialized Forge errors are rebuilt faithfully. Where the structured
code is genuinely gone, three codes are inferred from the message — stale
revision, rejected patch, blocked push — because each changes what the agent
must do next. Everything else stays generic rather than risk a confident
mislabel; inferred codes are marked `codeInferredFromMessage: true`.

### 6. Checkpoints record the commit they contain

**Was:** every file mutation snapshotted after the write but before the
auto-commit, so the checkpoint held a pre-commit HEAD with post-commit
contents.

**Now:** ordering is **commit → checkpoint → push**. The snapshot always agrees
with HEAD, and a push failure cannot cost it.

### 7. Recovery artifacts must be readable

**Was:** `forge_artifact_get` returned bytes only for images. Recovery patches
are stored as `text/plain`, so `forge_work_export` was write-only — the one
artifact that exists to rescue unpushed work could be created, sized and
described but never read back. Confirmed live: a 43,767-byte recovery patch
returned `size_bytes` and no content.

**Now:** text-shaped types return `content`, other binary returns
`content_base64`, both bounded by `max_bytes`.

### 8. The escape hatch must not depend on what it is escaping

**Was:** reading a recovery artifact called `tryGetState()` on the workspace's
own Durable Object, unbounded — so a workspace that had stopped answering
blocked the read of the artifact written *because* that workspace was in
trouble.

**Now:** bounded at 5s, falling back to the `workspaces` row in D1, which
carries the same tenant **and** project binding without needing the container.
Authorization is unchanged in strength; degraded reads report
`source: 'degraded_workspace'`.

### 9. Context selection must see source files

**Was:** `forge_context_get` walked the filesystem with a 10,000-file cap.
`node_modules` consumed the budget before a single source file was reached.

**Now:** `git ls-files --cached --others --exclude-standard` — the repository's
own view. Newly written files are included; .gitignore keeps dependencies and
build output out. Newline-delimited rather than `-z`, so it does not depend on
NUL bytes surviving the exec transport.

### 10. Forge's own refusals must not look like GitHub's

**Was:** the git credential proxy wrapped receive-pack inspection in a bare
`catch` and reported every failure as "outside its approved branch or commit
scope" — a truncated body, an unparseable packet and a genuine scope violation
all reached the agent as an opaque 403 that appeared to come from GitHub.

**Now:** the real cause is preserved and the refuser is named
(`refusedBy: 'forge_git_proxy'`) with the expected ref and commit.
`assertReceivePackScope` reports what it actually saw.

Related: the push capability TTL was 5 minutes while the push itself is allowed
120s and the `ls-remote` verification another 60s. Raised to 15 minutes — time
is not what bounds that capability, which is pinned to one workspace,
repository, branch and exact commit.

## Still open

Carried from the failure register, not yet closed:

- **Workspace proof path concatenation.** `proveWorkspaceState` splits
  `git diff --name-only -z` on NUL. If NUL bytes do not survive the exec
  transport, every changed path arrives concatenated into one string. Needs a
  live container to confirm before changing — see contract 9 for the
  newline-delimited approach that would fix it.
- **Early operation receipts.** A workspace create that times out in the client
  but completes remotely leaves no handle to recover through.
- **Push authorization (HTTP 403).** Contract 10 makes the failure legible; it
  does not yet establish which side is refusing in production.
- **Targeted check planning.** `suggestChecks` exists but is not reachable from
  `forge_diff_metadata`.
