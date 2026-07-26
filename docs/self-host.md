# Run Forge on your own Mac mini

Forge can run workspaces (and browser evidence) on a machine you own — a Mac
mini is ideal because it's cheap, quiet, and can stay on 24/7. Forge **health-checks
your machine and only routes work to it when it's up and passing its self-test**;
otherwise it falls back to Cloudflare containers and Browser Run. The AI agent
using the MCP sees no difference either way — **Forge chooses the route**.

```
MCP agent ──▶ Forge (Cloudflare Worker) ──▶ health check ──▶ your Mac mini (healthy?)
                                                   │ yes ──▶ Mac mini (containers + Chrome)
                                                   │ no  ──▶ Cloudflare containers + Browser Run
```

Why self-host: unlimited local builds with real RAM, persistent package caches
(fast installs), your GitHub repos pre-cloned and ready, and no per-second
metering. Trade-offs: uptime and security are now yours — read [Security](#security).

---

> **Same model as the cloud.** A workspace is a **container**, exactly like Forge
> Cloud — one primitive everywhere. You install a container engine once (Colima,
> a light Docker on macOS); after that, everything is a container whether it runs
> on Cloudflare or your mini. Containers are run hardened (non-root, no
> capabilities, no host mounts, resource limits) so agent code is isolated from
> your machine.

## 1. One-time setup on the Mac mini

### Install prerequisites
```bash
brew install colima docker node   # container engine (Colima) + docker CLI + Node
colima start --cpu 4 --memory 8 --disk 60   # the container engine
docker version && node -v         # sanity
```

### Install the agent + build the workspace image
```bash
mkdir -p ~/forge-node-agent && cd ~/forge-node-agent
# copy self-host/forge-node-agent/* from this repo into here
npm install
npx playwright install chromium   # optional: local browser evidence
docker build -f Dockerfile.workspace -t forge-workspace:latest .   # the workspace image
```

### Generate a shared secret
```bash
openssl rand -hex 32     # this is your FORGE_AGENT_TOKEN — keep it secret
```

### Run the self-test (the "check if it's not buggy" step)
```bash
FORGE_AGENT_TOKEN=xxx npm run selftest
# Prints each check (docker up, workspace image present, a throwaway hardened
# container, chromium, disk) plus capacity. Exit 0 = healthy. Forge runs this
# same check before routing work to you.
```

---

## 2. Keep it always on

macOS sleeps by default — Forge can't reach a sleeping mini.

```bash
# Never sleep on power; wake on network; auto-restart after a power cut
sudo pmset -c sleep 0 disksleep 0 womp 1 autorestart 1
sudo systemsetup -setrestartfreeze on
```

- **Auto-start the agent at boot/login**: install the launchd service.
  ```bash
  cp com.forge.agent.plist ~/Library/LaunchAgents/com.forge.agent.plist
  # edit paths, token, and port inside the plist first
  launchctl load -w ~/Library/LaunchAgents/com.forge.agent.plist
  ```
  `KeepAlive` restarts the agent if it crashes; `RunAtLoad` starts it at login.
  Enable **automatic login** (System Settings → Users & Groups) so a reboot
  comes all the way back up unattended. Start the container engine at login too:
  `brew services start colima`.
- **Power cut**: `autorestart 1` above boots the mini back up when power returns.

---

## 3. Expose it to Forge (tunnel, no open ports)

Don't port-forward your home router. Use a Cloudflare Tunnel — the mini dials
out, nothing inbound is opened.

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create forge-mini
cloudflared tunnel route dns forge-mini forge-mini.yourdomain.com
# point the tunnel at the local agent
cloudflared tunnel run --url http://localhost:8787 forge-mini
```
Run the tunnel under launchd too so it survives reboots (`cloudflared service install`).

Then tell Forge about it (Worker secrets):
```bash
wrangler secret put FORGE_SELFHOST_TOKEN   # paste the same secret
# and set the URL + enable flag as vars (or secrets):
#   FORGE_SELFHOST_ENABLED = true
#   FORGE_SELFHOST_URL     = https://forge-mini.yourdomain.com
```
Unset/false ⇒ Forge stays Cloudflare-only. No redeploy of your workspaces needed.

---

## 4. Pre-install your GitHub repos (ready to go)

Bake the repos you use most into the **workspace image** so every container
starts with a warm copy already on disk (no host mounts needed — it's part of the
image, which keeps the hardened isolation intact). Add to `Dockerfile.workspace`:

```dockerfile
# warm clones baked into the image; refreshed each time you rebuild it
RUN git clone --depth 1 https://github.com/timcoy47/forge-mcp.git   /workspace/warm/forge-mcp \
 && git clone --depth 1 https://github.com/timcoy47/parallax-review.git /workspace/warm/parallax-review \
 && chown -R 1000:1000 /workspace/warm
```
Rebuild the image (e.g. nightly via launchd) to keep the warm copies fresh, and
have your provision step `git clone --reference /workspace/warm/<repo>` for a fast
local checkout. For **any authorised person**, access is granted the normal way —
give their Forge account access to the repositories through the Forge GitHub App;
the agent runs whatever repos Forge is authorised for, and the baked copies just
make them fast.

> Auth to private repos still flows through Forge's short-lived GitHub App
> credential — the agent never stores your GitHub token.

---

## 5. Browser evidence on the mini (optional, flaky)

The agent renders screenshots + accessibility trees with a local headless
Chromium. Chrome on a personal machine can be flaky, so Forge health-checks it
(`/v1/browser/health`) and **falls back to Cloudflare Browser Run** whenever it's
unhealthy — again, transparent to the agent. If you'd rather always use
Cloudflare for browser work, just leave Chromium uninstalled; the health check
fails and Forge routes browser calls to Cloudflare while still using the mini for
compute.

---

## 6. Concurrency

The agent runs up to `FORGE_AGENT_MAX_WORKSPACES` (default 4) containers at once,
each with its own memory/CPU limit (`FORGE_AGENT_MEMORY`, `FORGE_AGENT_CPUS`); the
practical limit is your mini's RAM/CPU (a 16 GB mini is comfortable with a few
concurrent light workspaces or one heavy build).

The agent reports `capacity: { max, inUse }` in `/v1/health`, and **Forge only
routes a new workspace to the mini when it's healthy *and* under capacity** —
otherwise that workspace goes to Cloudflare instead of thrashing your machine.
Idle workspaces are reaped locally after `FORGE_AGENT_IDLE_MINUTES` (default 240),
and Forge's own slot TTL destroys them too, so capacity frees itself.

Tune `FORGE_AGENT_MAX_WORKSPACES` to your hardware; raise it on a bigger box.

## 7. Take over a workspace by hand

A workspace is a live container, so you can attach a shell and drive it yourself —
to debug a stuck agent, fix something manually, or look before approving a push.
The agent reports ready-made commands:

```bash
# ask the agent about a workspace (providerId from forge_workspace_get)
curl -s -X POST https://forge-mini.yourdomain.com/v1/sandboxes/<providerId>/info \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
# → { container, open: { shell, logs } }
docker exec -it forge-<id> bash   # attach a shell inside the workspace
docker logs forge-<id>            # see what it's been doing
```

The Forge app surfaces this as **Attach shell / View logs** on any workspace
running on your mini. When would you actually need it? Rarely on the happy path —
it earns its keep for **debugging, manual intervention, and building trust** while
you're getting comfortable letting an agent run. What you do in the shell is
exactly what the agent sees next — it's the same container.

## 8. Security

You're running untrusted, agent-authored code on your hardware. The agent runs
every workspace container **hardened by default**, and you should keep the mini
disposable:

- **Isolation**: each workspace is a container started with `--user 1000`
  (non-root), `--cap-drop ALL`, `--security-opt no-new-privileges`, **no host
  mounts**, and memory/CPU/pids limits — so agent code can't escalate or touch
  your machine. Keep the mini disposable anyway: no personal data, a machine
  you'd be fine wiping.
- **No secrets on the box**: the only secret is `FORGE_AGENT_TOKEN`. GitHub auth
  comes per-clone from Forge; don't log in to `gh` or store PATs on the mini.
- **Network**: the mini dials out through the tunnel; nothing inbound is opened.
  Optionally firewall outbound so workspaces reach package registries but not the
  rest of your LAN.
- **The tunnel** authenticates every request with the bearer token; rotate it if
  leaked (`wrangler secret put` + restart the agent with the new value).

---

## 9. How Forge decides (so you can reason about it)

On `forge_workspace_create`, Forge calls your agent's `POST /v1/health`. If it
returns `{ healthy: true }` **and has spare capacity**, the workspace is created
on the mini and **stays** on the mini for its whole life. If the check fails
(mini asleep, Docker down, tunnel dropped) or the mini is full, Forge
silently creates it on Cloudflare instead. Browser calls are gated the same way,
cached for ~60s. Watch it live:

```bash
wrangler tail --format pretty | grep forge_sandbox_route
# forge_sandbox_route { chosen: 'self-hosted' }        ← using the mini
# forge_sandbox_route_fallback { chosen: 'cloudflare' } ← mini unhealthy, fell back
```

---

## Reference agent

`self-host/forge-node-agent/` is a runnable reference: health/self-test, and the
full workspace loop as hardened containers — create / exec / read / write /
patch / tree / destroy, **background processes** (`forge_process_start`), **live
previews** (a dev server on a published port, reachable through the agent's
`/preview/<id>/<port>/` proxy so `forge_browser_act` can tap and screenshot it),
and browser capture over Playwright. Only snapshots return "unsupported". Preview
ports must be published at container start — the common dev ports are by default
(`FORGE_AGENT_PREVIEW_PORTS` to change). It's deliberately small so you can read
the whole thing before trusting it with code execution.
