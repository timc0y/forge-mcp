# Run Forge on your own Mac mini

Forge can run workspaces (and browser evidence) on a machine you own — a Mac
mini is ideal because it's cheap, quiet, and can stay on 24/7. Forge **health-checks
your machine and only routes work to it when it's up and passing its self-test**;
otherwise it falls back to Cloudflare containers and Browser Run. The AI agent
using the MCP sees no difference either way — **Forge chooses the route**.

```
MCP agent ──▶ Forge (Cloudflare Worker) ──▶ health check ──▶ your Mac mini (healthy?)
                                                   │ yes ──▶ Mac mini (folders + local tools + Chrome)
                                                   │ no  ──▶ Cloudflare containers + Browser Run
```

Why self-host: unlimited local builds with real RAM, persistent package caches
(fast installs), your GitHub repos pre-cloned and ready, and no per-second
metering. Trade-offs: uptime and security are now yours — read [Security](#security).

---

> **No Docker.** A workspace is just a folder under a work root, and commands run
> with the tools you installed via Homebrew. There is nothing container-shaped to
> learn. (If you ever want VM-grade isolation you can opt into Apple's native
> `container` runtime, but it's off by default and not required.)

## 1. One-time setup on the Mac mini

### Install prerequisites
```bash
# Homebrew + whatever your repos actually need to build
brew install node git            # add python, go, … as needed
node -v && git --version         # sanity
```

### Install the agent
```bash
mkdir -p ~/forge-node-agent && cd ~/forge-node-agent
# copy self-host/forge-node-agent/* from this repo into here
npm install
npx playwright install chromium  # optional: local browser evidence
```

### Generate a shared secret
```bash
openssl rand -hex 32     # this is your FORGE_AGENT_TOKEN — keep it secret
```

### Run the self-test (the "check if it's not buggy" step)
```bash
FORGE_AGENT_TOKEN=xxx npm run selftest
# Prints each check (workroot writable, git, node, a throwaway shell command,
# chromium, disk) plus capacity. Exit 0 = healthy. Forge runs this same check
# before routing work to you.
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
  comes all the way back up unattended. Nothing else needs to start — there is no
  container engine to launch.
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

Warm a shared cache so new workspaces start from a local clone instead of a cold
fetch. Keep it fresh with a cron/launchd job:

```bash
# ~/forge-cache/refresh.sh
for repo in timcoy47/forge-mcp timcoy47/parallax-review; do
  dir=~/forge-cache/$(echo "$repo" | tr / _)
  if [ -d "$dir" ]; then git -C "$dir" fetch --all --prune
  else git clone --mirror "https://github.com/$repo.git" "$dir"; fi
done
```
```bash
# refresh every 15 min
(crontab -l 2>/dev/null; echo "*/15 * * * * ~/forge-cache/refresh.sh") | crontab -
```
Clone new workspaces from this local mirror (`git clone --reference`), so they
start from a warm copy instead of a cold fetch. For **any authorised person**, grant access
by adding their repos to this list and giving their Forge account access to the
same repositories through the Forge GitHub App — the agent runs whatever repos
Forge is authorised for; the cache just makes them fast.

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

The agent runs up to `FORGE_AGENT_MAX_WORKSPACES` (default 4) at once. Each is a
separate folder and separate processes, so the OS handles the parallelism; the
practical limit is your mini's RAM/CPU (a 16 GB mini is comfortable with a few
concurrent light workspaces or one heavy build).

The agent reports `capacity: { max, inUse }` in `/v1/health`, and **Forge only
routes a new workspace to the mini when it's healthy *and* under capacity** —
otherwise that workspace goes to Cloudflare instead of thrashing your machine.
Idle workspaces are reaped locally after `FORGE_AGENT_IDLE_MINUTES` (default 60),
and Forge's own slot TTL destroys them too, so capacity frees itself.

Tune `FORGE_AGENT_MAX_WORKSPACES` to your hardware; raise it on a bigger box.

## 7. Take over a workspace by hand

Because a workspace is just a folder, you can jump in and drive it yourself — to
debug a stuck agent, fix something manually, or look before approving a push. The
agent reports the folder and ready-made open commands:

```bash
# ask the agent where a workspace lives (providerId from forge_workspace_get)
curl -s -X POST https://forge-mini.yourdomain.com/v1/sandboxes/<providerId>/info \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
# → { localPath, open: { finder, terminal, vscode } }
open <localPath>          # Finder
cd <localPath> && $SHELL  # Terminal
code <localPath>          # VS Code
```

The Forge app surfaces these as **Open in Finder / Terminal / VS Code** on any
workspace running on your mini. When would you actually need it? Rarely on the
happy path — it earns its keep for **debugging, manual intervention, and building
trust** while you're getting comfortable letting an agent run. Changes you make
in the folder are exactly what the agent sees next, since it's the same directory.

## 8. Security

You're running untrusted, agent-authored code on your hardware. Minimum bar:

- **Isolation**: workspaces are isolated by the OS user. Set `FORGE_AGENT_USER`
  to a **dedicated low-privilege macOS account** so agent commands run as that
  user (via `sudo -u`), not as you, and keep the mini disposable — no personal
  data, a machine you'd be fine wiping. Want VM-grade isolation? Opt into Apple's
  native `container` runtime — but it's not required.
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
(mini asleep, git/node missing, tunnel dropped) or the mini is full, Forge
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
core workspace loop (create / exec / read / write / patch / tree / destroy) as
plain folders + processes (no Docker), plus browser capture over Playwright.
Background processes, preview-port exposure, and snapshots return an explicit
"unsupported" error — extend them for your setup. It is deliberately small so you
can read the whole thing before trusting it with code execution.
