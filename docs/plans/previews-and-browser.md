# Previews and Browser Sessions

**Status**: Process/preview model exists in gateway; browser-session model implemented in `@forge/browser-core`; interactive-session and evidence runtime integrations are pending.

## Concepts
*   **Preview**: Private URL exposing a running process.
*   **Browser Session**: Interactive headless browser instance accessing a preview.

## Browser Session Lifecycle
Defined in `@forge/browser-core/session`:
`opening → open ↔ open → closing → closed` (or `failed`)

*   **Telemetry**: Records active time, viewports, path history, and capture IDs.
*   **Viewports**: Utilizes `PHONE_VIEWPORT` and `DESKTOP_VIEWPORT`.
*   **Gating**: Opened only for interactive user journeys; skipped for backend, doc, or unit-test workflows.

## Proposed API Surface
*   `forge_browser_open`
*   `forge_browser_get`
*   `forge_browser_interact` (handles navigation, typing, and clicks)
*   `forge_browser_capture`
*   `forge_browser_close`

## Current Implementation Limitations
*   Tools require the workspace coordinator to orchestrate a browser runtime against a preview.
*   Currently, `forge_review` captures static evidence from external URLs and `forge_preview` captures workspace previews. Interactive sessions are not yet active.
