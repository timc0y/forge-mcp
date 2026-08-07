# Self-Hosted Browser Agent

Optional proxy for rendering screenshots, accessibility trees, and browser interactions on custom compute. Sandboxed workspace shell commands still execute exclusively on Cloudflare.

## Setup
```bash
brew install node
cd self-host/forge-node-agent
npm install
npx playwright install chromium
FORGE_AGENT_TOKEN=$(openssl rand -hex 32) npm run selftest
FORGE_AGENT_TOKEN=xxx npm start
```
*   macos Service: Edit and load launchd agent using `com.forge.agent.plist`.

## Connection
Configure the Edge Worker:
```bash
wrangler secret put FORGE_SELFHOST_TOKEN
# Set variables: FORGE_SELFHOST_ENABLED=true, FORGE_SELFHOST_URL=https://your-tunnel-endpoint
```
Forge health-checks the endpoint via `POST /v1/browser/health`. Unhealthy endpoints trigger automatic fallback to Cloudflare Browser Run.

## Security
*   SSRF Boundary: Rejects loopback, private-network, `.local`, and `.internal` targets.
*   Bearer token auth required on all requests.
*   Isolates Playwright context per action; runs headless.

## API Surface
Exposes:
*   `POST /v1/browser/health`
*   `POST /v1/browser/capture`
*   `POST /v1/browser/screenshot`
*   `POST /v1/browser/accessibility`
*   `POST /v1/browser/act`
*   *Note*: No filesystem, process, preview, or terminal command endpoints.
