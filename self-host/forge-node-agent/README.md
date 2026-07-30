# Forge browser agent

This optional agent renders browser evidence with Chromium on a machine you
own. Forge health-checks it and falls back to Cloudflare Browser Run when it is
unavailable.

It does **not** run repository commands or hold workspace files. Cloudflare
Sandbox is Forge's only execution provider; GitHub is the only durable code
store.

```bash
brew install node
npm install
npx playwright install chromium
FORGE_AGENT_TOKEN=$(openssl rand -hex 32) npm run selftest
FORGE_AGENT_TOKEN=xxx npm start
```

Expose the service through an authenticated tunnel, then configure the Worker
with `FORGE_SELFHOST_ENABLED`, `FORGE_SELFHOST_URL`, and
`FORGE_SELFHOST_TOKEN`. The only routes are browser health, capture, screenshot,
accessibility, and interaction under `/v1/browser/*`.

See [`docs/self-host.md`](../../docs/self-host.md) for setup and security notes.
