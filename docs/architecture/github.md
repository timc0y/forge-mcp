# GitHub architecture

Forge uses a GitHub App. Repository authorization is verified at each external
operation against tenant membership, installation state, repository inclusion,
permission, and branch policy.

A reusable installation token never enters the sandbox. Installation tokens
are minted inside the edge gateway for narrowly scoped API reads/writes. The
workspace checkout is a cache for execution, not the authority for repository
durability.

The private pilot uses GitHub as the Forge account identity and synchronizes
repositories selected in the `forge-mcp-cloud` installation. `forge_start`
creates a `forge/*` ref with a base-SHA/idempotency guard. `forge_edit` builds a
Git commit through the GitHub API, updates only the guarded feature ref, then
reads the ref back and requires the expected SHA before reporting remote
durability. Installation and repository-removal webhooks revoke stale
authorization.

Generated commits use the visible `forge-mcp[bot]` identity and never claim
human authorship. Raw `git push` through `forge_shell` is refused because it
bypasses expected-tip, idempotency, authorization, and read-back checks.
`forge_merge` opens the human review path from the already-remote feature
branch; `forge_pr` rechecks the live head, statuses, reviews, and mergeability,
then requires human approval bound to that exact merge or close intent.
