# Self-hosted browser evidence

Forge can optionally render screenshots, accessibility trees, and browser
interactions on a machine you own. This is a browser-only optimization:

- GitHub remains the durable repository and code-editing plane.
- Cloudflare Sandbox remains the only command execution plane.
- The self-hosted machine never receives a repository checkout or runs agent
  shell commands.
- Forge falls back to Cloudflare Browser Run when the local Chromium is
  unavailable.

The reference implementation is in `self-host/forge-node-agent`.

## Setup

```bash
brew install node
cd self-host/forge-node-agent
npm install
npx playwright install chromium
openssl rand -hex 32
```

Use the generated value as `FORGE_AGENT_TOKEN`, then verify and start the
agent:

```bash
FORGE_AGENT_TOKEN=xxx npm run selftest
FORGE_AGENT_TOKEN=xxx npm start
```

The bundled `com.forge.agent.plist` is a launchd example for keeping the agent
running on macOS. Edit its paths and token before loading it.

## Connect Forge

Do not open a router port. Put the agent behind a Cloudflare Tunnel or an
equivalent authenticated public endpoint, then configure the Worker:

```bash
wrangler secret put FORGE_SELFHOST_TOKEN
# FORGE_SELFHOST_ENABLED=true
# FORGE_SELFHOST_URL=https://forge-browser.yourdomain.com
```

Forge probes `POST /v1/browser/health` before choosing the agent. An unhealthy
or unconfigured agent is ignored and Browser Run handles the request instead.

## Security boundary

The bearer token authenticates every request. Rotate it in both places if it is
exposed. The agent rejects loopback, private-network, `.local`, and `.internal`
targets as a second SSRF boundary; Forge should route only its own public preview
origins to this provider.

Keep the machine free of unrelated credentials and personal browser profiles.
The agent launches an isolated headless Chromium context per capture, but it is
still software processing agent-selected public pages on hardware you operate.

## Supported surface

The reference agent implements only:

- `POST /v1/browser/health`
- `POST /v1/browser/capture`
- `POST /v1/browser/screenshot`
- `POST /v1/browser/accessibility`
- `POST /v1/browser/act`

There are deliberately no sandbox, filesystem, process, preview-proxy,
suspend/resume, or snapshot endpoints.
