# Tool-design lessons

These constraints explain Forge's current shape. [SIMPLE.md](../../SIMPLE.md)
owns the current contract; the source and regression tests establish its behaviour.

## Keep useful work in GitHub

A successful edit must already be an ordinary GitHub commit, with its branch,
SHA and URL. A temporary execution environment must never hold the only copy.
Forge does not execute repository code; coding tools and repository CI own that.

## Make one conversation turn useful

Chat clients cannot reliably loop, poll or preserve opaque identifiers across
turns. Return evidence with the result and human-meaningful addresses. Keep the
five tools small enough for a client to discover and select them accurately.
Long-lived merge and discard decisions use one human approval link completed
server-side, rather than a sequence the conversation must coordinate.

## Preserve authority at the moment of action

Intersect the user's permissions with the GitHub App grant for every repository
operation. Installation-wide credentials cannot stand in for a user's authority.
Recheck access on bearer requests, refresh, OAuth and approval execution.
Missing or malformed allowlists deny all access.

## Do not overwrite concurrent work

Pin reads and checks to immutable commits. Commit against an expected branch
head, and reject overlapping concurrent edits. A branch moving forward is not
proof that reapplying the same change is safe. Preserve known candidate commits
when a provider response leaves the effect uncertain; never replay blindly.

## Distinguish proof from inference

Source tests, provider behaviour, a deployment and a fresh client journey are
separate evidence. A complete build does not prove client tool discovery.
Incomplete repository evidence cannot justify a successful semantic answer.
Retiring source does not remove old databases, objects, logs or provider bindings.

## Bound paid work before starting it

Capture consent, per-person attempt limits and shared inference admission have
different owners. Reserve allowance atomically before a paid attempt. Unknown
provider outcomes remain charged against the attempt limit; missing usage is
not evidence of zero cost. Call limits are not spending guarantees.

## Keep public and operator records separate

Public documentation explains the product, setup, limits and verification.
Endpoints, account identifiers, credentials, deployment records and private test
receipts belong with each operator. Rewriting a branch cannot erase other
people's clones or provider-retained history.
