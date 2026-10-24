# Live MCP self-test — 2026-09-20

Requested from ChatGPT against Forge's own repository.

Status: completed with failures.

## Live results

- `forge_read`: PASS for repository listing, tree reads, file reads, history, hygiene, size/shape, quality, dependencies, languages, map, migrations, policy lookup, and public-repository search.
- `forge_read` exact/semantic committed-code search: FAIL for known symbols (`CHANGE_BRANCH`, `FORGE_PUBLIC_ORIGIN`, `installationForLogin` all returned no matches even though they exist in committed files).
- `forge_edit` direct write: PASS. Created this record on `main`.
- `forge_edit` fragment replacement: PASS. This section was written through the replacement path.
- `forge_edit` review/change mode: FAIL reproducibly. Two attempts to create the fixed `forge` branch returned `FORGE_VALIDATION_FAILED: GitHub refused the creation of forge: Reference update failed`.
- `forge_see`: PASS on `https://timcoy.uk/forge` at phone and desktop viewports, with a source pointer returned.
- `forge_merge`: endpoint reachable and error handling PASS (`FORGE_NOT_FOUND` when no open change exists); happy path BLOCKED because review/change creation fails.
- `forge_discard`: endpoint reachable and error handling PASS (`FORGE_NOT_FOUND` when no open change exists); happy path BLOCKED because review/change creation fails.

Overall: the five-tool surface is exposed and callable, but production is not fully healthy because the review branch cannot currently be created. Exact/semantic committed-code search also appears broken for known literals/symbols.
