# Previews and browser sessions

Status: process/preview model present in the gateway; browser-session model
implemented in `@forge/browser-core`; interactive-session runtime wiring pending.

## Concepts (kept distinct)

- **Preview** — a private live URL exposing a running process. Not a screenshot.
- **Browser session** — an interactive browser instance visiting a preview.
  Not the application preview itself.

## Browser session model

`@forge/browser-core/session` provides a pure lifecycle:
`opening → open ↔ open → closing → closed` (with `failed`). It carries the
workspace id, preview id, viewport, current path, capture ids and accumulated
active time (for cost accounting). Interactions (`navigate`, `set-viewport`,
`click`, `type`) apply to session state purely; the provider performs the I/O.
`PHONE_VIEWPORT` and `DESKTOP_VIEWPORT` back phone/desktop review.

Browser use is deliberate. A session is never opened automatically for
documentation, backend-only, type-definition, pure unit-test or config-only
changes.

## Intended tool surface

`forge_browser_open`, `forge_browser_get`, `forge_browser_interact`,
`forge_browser_capture`, `forge_browser_close`. A screenshot alone must never be
represented as proof that a multi-step journey passed (enforced by the evidence
model: `screenshot`/`accessibility_snapshot` cannot be `passed`).

## Runtime wiring pending

The interactive tools require the workspace coordinator to hold browser-session
state and drive Browser Rendering against a preview. That path depends on live
Cloudflare runtime and is validated by cloud acceptance, not repository-local
tests, so it is intentionally not wired into `ForgeToolHandlers` until it can be
exercised. Today `forge_review`, `forge_review_capture`,
`forge_browser_screenshot` and `forge_browser_accessibility_tree` provide
capture; this plan adds the interactive session layer on top of that model.
