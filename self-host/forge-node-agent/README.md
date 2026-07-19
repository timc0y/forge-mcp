# Forge Node Agent (reference)

Runs Forge workspaces + browser evidence on a machine you own (e.g. a Mac mini).
**Same model as Forge Cloud: every workspace is a container.** One primitive
everywhere — nothing bespoke to reason about. Forge health-checks this agent and
routes work here only when it's healthy and has spare capacity, otherwise it
falls back to Cloudflare — transparent to the MCP caller.

Containers are run **hardened by default**: non-root (`--user 1000`), all Linux
capabilities dropped, no privilege escalation, no host mounts, memory/CPU/pids
limits — so agent-authored code is isolated from your machine.

Quick start:
```bash
brew install colima docker node   # Docker engine (Colima) + CLI + Node for the agent
colima start --cpu 4 --memory 8 --disk 60
npm install
npx playwright install chromium   # optional: local browser evidence
docker build -f Dockerfile.workspace -t forge-workspace:latest .
FORGE_AGENT_TOKEN=$(openssl rand -hex 32) npm run selftest   # must exit 0
FORGE_AGENT_TOKEN=xxx npm start                              # listens on :8787
```

Full setup — always-on, tunnel, pre-cloned repos, concurrency, taking over a
workspace, security — is in
[`docs/self-host/mac-mini.md`](../../docs/self-host/mac-mini.md).

Implements: `POST /v1/health` (with `capacity`), `/v1/browser/health`, sandbox
create/exec/suspend/resume/destroy/info, `files/{read,write,patch,tree}`, and
browser `capture/screenshot/accessibility/act`. Background processes, preview
ports, and snapshots return an explicit 501 — extend as needed.
