# Forge Node Agent (reference)

Runs Forge workspaces + browser evidence on a machine you own (e.g. a Mac mini).
**No Docker** — a workspace is just a folder, and commands run with the tools you
installed. Forge health-checks this agent and routes work to it only when it's
healthy and has spare capacity, falling back to Cloudflare otherwise —
transparent to the MCP caller.

Quick start:
```bash
brew install node git            # the "toolchain" is just what your repos need
npm install
npx playwright install chromium  # optional: local browser evidence
FORGE_AGENT_TOKEN=$(openssl rand -hex 32) npm run selftest   # must exit 0
FORGE_AGENT_TOKEN=xxx npm start                               # listens on :8787
```

Full setup — always-on, tunnel, pre-cloned repos, concurrency, taking over a
workspace by hand, security — is in
[`docs/self-host/mac-mini.md`](../../docs/self-host/mac-mini.md).

Implements: `POST /v1/health` (with `capacity`), `/v1/browser/health`, sandbox
create/exec/suspend/resume/destroy/info, `files/{read,write,patch,tree}`, and
browser `capture/screenshot/accessibility/act`. Background processes, preview
ports, and snapshots return an explicit 501 — extend as needed.
