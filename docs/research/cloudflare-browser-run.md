# Cloudflare Browser Run research

- Repository/package: `cloudflare/puppeteer`, `@cloudflare/puppeteer` 1.1.0
- Maturity: stable screenshot/accessibility path; richer agent features treated as beta
- Used surface: browser launch, viewport, navigation, screenshot, accessibility snapshot
- Selected for browser evidence without placing browser control in the model host
- Fallback: Playwright inside Sandbox for deterministic project tests
- Risk: browser version/API lag and binding quotas
- Verified: 2026-07-12
