# Cloudflare Browser Run research

- Platform surface: Worker `BrowserRun` binding, typed by `@cloudflare/workers-types` 5.20260712.1
- Maturity: Quick Actions are production; richer agent features remain beta
- Used surface: `quickAction("snapshot")` with screenshot, accessibility tree, viewport and scoped request headers
- Selected for browser evidence without placing browser control in the model host
- Fallback: Puppeteer or Playwright inside Sandbox for deterministic project tests
- Risk: the July 2026 snapshot `formats` option is newer than the generated binding overload; the cast is isolated in the Cloudflare adapter and a deployed acceptance test validates the response
- Verified: 2026-07-12

Forge uses one stateless snapshot action per viewport rather than opening separate browser sessions for the screenshot and accessibility tree. This is cheaper, faster and easier to tear down. Live View, recording, WebMCP, Stagehand and Playwright MCP are not in the product path.
