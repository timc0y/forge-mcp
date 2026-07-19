# Forge Node Agent (reference)

Runs Forge workspaces + browser evidence on a self-hosted machine (e.g. a Mac
mini). Forge health-checks this agent and routes work to it, falling back to
Cloudflare when it's down — transparent to the MCP caller.

Quick start:
```bash
npm install
npx playwright install chromium
docker build -f Dockerfile.workspace -t forge-workspace:latest .
FORGE_AGENT_TOKEN=$(openssl rand -hex 32) npm run selftest   # must exit 0
FORGE_AGENT_TOKEN=xxx npm start                               # listens on :8787
```

Full setup — always-on, tunnel, pre-cloned repos, security — is in
[`docs/self-host/mac-mini.md`](../../docs/self-host/mac-mini.md).

Implements: `POST /v1/health`, `/v1/browser/health`, sandbox
create/exec/suspend/resume/destroy, `files/{read,write,patch,tree}`, and browser
`capture/screenshot/accessibility/act`. Background processes, preview ports, and
snapshots return an explicit 501 — extend as needed.
