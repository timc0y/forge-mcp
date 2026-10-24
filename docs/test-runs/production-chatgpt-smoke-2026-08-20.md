# Production ChatGPT smoke run — 20 August 2026

**Surface:** ordinary production ChatGPT conversation  
**Server:** `https://timcoy.uk/forge/mcp`  
**Repository:** `timc0y/forge-mcp`  
**Purpose:** prove the five-tool surface one useful call at a time

## Observed

1. `forge_read` listed the repositories available to the connected account.
2. `forge_see` captured `https://timcoy.uk/forge` at phone and desktop and
   returned both images plus a signed gallery link.
3. `forge_read` narrowed the repository list to names matching `forge-mcp`.
4. `forge_edit` created a temporary change named `end-to-end smoke test` and
   added exactly one file, `docs/forge-e2e-smoke-test.md`.
5. `forge_read` read the open change and the added file back from GitHub,
   confirming that the durable commit existed before the reply.
6. `forge_merge` prepared a merge approval link. The link was deliberately not
   opened.
7. `forge_discard` prepared a discard approval link for the same temporary
   change.

## What this proves

- The production OAuth and GitHub App path can reach a real repository.
- An edit is durable on GitHub before the tool returns.
- A later turn can recover the change by its human intent rather than an opaque
  identifier.
- Screenshot evidence arrives inline and at a link.
- Merge and discard are separated from the chat as explicit human decisions.

## What this does not prove

- No approval click was recorded in this trace, so it does not prove the
  server-side merge or discard completion path.
- It does not prove behaviour across every ChatGPT plan, workspace, model or
  device.
- The screenshots cover the top viewport, not the full scrollable page.
- Forge did not build, test or deploy the repository.

The remaining release proof is one recorded successful merge approval and one
recorded successful discard approval, each followed by a GitHub read confirming
the final state.
