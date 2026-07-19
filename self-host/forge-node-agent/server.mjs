#!/usr/bin/env node
// Forge Node Agent (reference implementation)
// ------------------------------------------------------------------
// Runs Forge workspaces + browser evidence on a machine you own (Mac mini,
// Linux box). Same model as Forge Cloud: every workspace is a container. Forge
// health-checks this agent and routes work here only when it's up and has spare
// capacity, otherwise it falls back to Cloudflare — transparent to the caller.
//
// One primitive everywhere: a workspace == a container. Inside it, /workspace is
// a real path, so there is nothing bespoke to reason about. Containers are run
// hardened by default (non-root, all Linux capabilities dropped, no host mounts,
// memory/CPU/pids limits) so agent-authored code is isolated from your machine.
//
// Config (env):
//   FORGE_AGENT_TOKEN          (required) shared secret; = FORGE_SELFHOST_TOKEN in Forge
//   FORGE_AGENT_PORT           (default 8787)
//   FORGE_AGENT_IMAGE          (default forge-workspace:latest) workspace base image
//   FORGE_AGENT_MAX_WORKSPACES (default 4)
//   FORGE_AGENT_MEMORY         (default 2g)   per-workspace memory limit
//   FORGE_AGENT_CPUS           (default 2)    per-workspace CPU limit
//   FORGE_AGENT_IDLE_MINUTES   (default 240)  local idle-container reaper

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const TOKEN = process.env.FORGE_AGENT_TOKEN;
const PORT = Number(process.env.FORGE_AGENT_PORT || 8787);
const IMAGE = process.env.FORGE_AGENT_IMAGE || 'forge-workspace:latest';
const MAX = Number(process.env.FORGE_AGENT_MAX_WORKSPACES || 4);
const MEMORY = process.env.FORGE_AGENT_MEMORY || '2g';
const CPUS = process.env.FORGE_AGENT_CPUS || '2';
const IDLE_MS = Number(process.env.FORGE_AGENT_IDLE_MINUTES || 240) * 60_000;

if (!TOKEN) {
  console.error('FORGE_AGENT_TOKEN is required.');
  process.exit(1);
}

/** @type {Map<string, { name: string, lastActive: number }>} */
const workspaces = new Map();
const nameFor = (providerId) => `forge-${String(providerId).replace(/[^a-z0-9_.-]/gi, '').slice(0, 60)}`;
const touch = (id) => {
  const w = workspaces.get(id);
  if (w) w.lastActive = Date.now();
};
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// Run a process, capture output, never reject (callers inspect exitCode).
function spawnCapture(argv, { stdin, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1));
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    if (stdin !== undefined) child.stdin.end(stdin);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr, durationMs: Date.now() - started });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: String(err.message), durationMs: Date.now() - started });
    });
  });
}
const docker = (args, opts) => spawnCapture(['docker', ...args], opts);

// Run a shell command inside a workspace container. /workspace is real inside,
// so no path rewriting — cwd and paths pass through unchanged.
function dexec(id, command, { cwd = '/workspace', timeoutMs = 120_000, stdin } = {}) {
  const argv = ['exec', '-w', cwd, ...(stdin !== undefined ? ['-i'] : []), nameFor(id), 'bash', '-lc', command];
  return docker(argv, { stdin, timeoutMs }).then((r) => ({
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    truncated: false,
    durationMs: r.durationMs,
    artifactRefs: []
  }));
}

// ---- browser (Playwright) ---------------------------------------------------
let browserPromise = null;
async function chromium() {
  if (!browserPromise) {
    const { chromium: pw } = await import('playwright');
    browserPromise = pw.launch({ headless: true });
  }
  return browserPromise;
}
async function render({ input, steps }) {
  const browser = await chromium();
  const context = await browser.newContext({
    viewport: { width: input.viewport?.width ?? 1440, height: input.viewport?.height ?? 900 },
    extraHTTPHeaders: input.headers
  });
  const page = await context.newPage();
  try {
    const base = input.url.endsWith('/') ? input.url : `${input.url}/`;
    const url = new URL((input.path || '/').replace(/^\/+/, ''), base).toString();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    for (const step of steps ?? []) {
      if (step.kind === 'click') await page.click(step.selector, { timeout: step.timeoutMs ?? 10_000 });
      else if (step.kind === 'fill') await page.fill(step.selector, step.value ?? '');
      else if (step.kind === 'press') await page.keyboard.press(step.key);
      else if (step.kind === 'wait_for_selector') await page.waitForSelector(step.selector, { timeout: step.timeoutMs ?? 10_000 });
      else if (step.kind === 'wait_for_text') await page.getByText(step.text).first().waitFor({ timeout: step.timeoutMs ?? 10_000 });
      else if (step.kind === 'wait') await page.waitForTimeout(step.timeoutMs ?? 1000);
      else if (step.kind === 'reload') await page.reload({ waitUntil: 'domcontentloaded' });
      else if (step.kind === 'navigate') await page.goto(new URL((step.path || '/').replace(/^\/+/, ''), url).toString(), { waitUntil: 'domcontentloaded' });
    }
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: Boolean(input.fullPage) });
    const tree = await page.accessibility.snapshot({ interestingOnly: false });
    return { screenshotBase64: jpeg.toString('base64'), contentType: 'image/jpeg', accessibilityTree: tree, finalUrl: page.url(), width: input.viewport?.width, height: input.viewport?.height };
  } finally {
    await context.close();
  }
}

// ---- health / self-test -----------------------------------------------------
async function health() {
  const checks = [];
  const check = async (name, fn) => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error.message ?? error).slice(0, 200) });
    }
  };
  await check('docker', async () => {
    const r = await docker(['version', '--format', '{{.Server.Version}}']);
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'docker not reachable');
    return r.stdout.trim();
  });
  await check('image', async () => {
    const r = await docker(['image', 'inspect', IMAGE]);
    if (r.exitCode !== 0) throw new Error(`image ${IMAGE} not built`);
    return IMAGE;
  });
  await check('container-run', async () => {
    const r = await docker(['run', '--rm', ...HARDENING, IMAGE, 'bash', '-lc', 'echo ok'], { timeoutMs: 60_000 });
    if (!r.stdout.includes('ok')) throw new Error(r.stderr.trim() || 'self-test container failed');
    return 'ran hardened throwaway container';
  });
  await check('chromium', async () => {
    const ctx = await (await chromium()).newContext();
    await ctx.close();
    return 'launched';
  });
  await check('disk', async () => (await spawnCapture(['df', '-h', '/'])).stdout.trim().split('\n').pop());
  const coreOk = checks.filter((c) => ['docker', 'image', 'container-run'].includes(c.name)).every((c) => c.ok);
  return { healthy: coreOk, checks, capacity: { max: MAX, inUse: workspaces.size } };
}

// Security baseline for every workspace container: unprivileged, no capabilities,
// no privilege escalation, no host mounts, bounded resources.
const HARDENING = [
  '--user', '1000:1000',
  '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges',
  '--pids-limit', '512',
  '--memory', MEMORY,
  '--cpus', CPUS,
  '--label', 'forge=1'
];

// Common dev-server ports published to loopback at container-create time (Docker
// can only publish ports at run time). A preview on one of these is reachable;
// override with FORGE_AGENT_PREVIEW_PORTS. Matches the cloud image's EXPOSE set.
const PREVIEW_PORTS = (process.env.FORGE_AGENT_PREVIEW_PORTS || '3000,4321,5173,8000,8080')
  .split(',').map((s) => s.trim()).filter(Boolean);
const PORT_ARGS = PREVIEW_PORTS.flatMap((p) => ['-p', `127.0.0.1::${p}`]);

// Look up the loopback host port Docker mapped a container port to.
async function hostPortFor(id, containerPort) {
  const r = await docker(['port', nameFor(id), `${containerPort}/tcp`]);
  const match = r.stdout.trim().match(/:(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

// ---- routing ----------------------------------------------------------------
async function handle(method, url, body) {
  const p = url.split('?')[0];
  if (p === '/v1/health') return health();
  if (p === '/v1/browser/health') {
    try {
      const ctx = await (await chromium()).newContext();
      await ctx.close();
      return { healthy: true };
    } catch {
      return { healthy: false };
    }
  }

  if (p === '/v1/sandboxes') {
    const { input } = body;
    if (workspaces.size >= MAX && !workspaces.has(input.providerId)) throw httpError(503, `At capacity (${workspaces.size}/${MAX}).`);
    const name = nameFor(input.providerId);
    await docker(['rm', '-f', name]);
    const run = await docker(['run', '-d', '--name', name, ...HARDENING, ...PORT_ARGS, IMAGE, 'sleep', 'infinity']);
    if (run.exitCode !== 0) throw httpError(500, `docker run failed: ${run.stderr.slice(0, 300)}`);
    await dexec(input.providerId, 'mkdir -p /workspace/repo /workspace/tmp');
    workspaces.set(input.providerId, { name, lastActive: Date.now() });
    return { providerId: input.providerId };
  }

  const m = p.match(/^\/v1\/sandboxes\/([^/]+)\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const action = m[2];
    touch(id);
    if (action === 'info') {
      // Take over by attaching a shell to the live container.
      return { providerId: id, container: nameFor(id), open: { shell: `docker exec -it ${nameFor(id)} bash`, logs: `docker logs ${nameFor(id)}` } };
    }
    if (action === 'destroy') {
      await docker(['rm', '-f', nameFor(id)]);
      workspaces.delete(id);
      return {};
    }
    if (action === 'suspend') return void (await docker(['pause', nameFor(id)])) ?? {};
    if (action === 'resume') return void (await docker(['unpause', nameFor(id)])) ?? {};
    if (action === 'exec') {
      const i = body.input;
      return dexec(id, i.command, { cwd: i.cwd, timeoutMs: i.timeoutMs, stdin: i.stdin });
    }
    if (action === 'files/read') {
      const i = body.input;
      const r = await dexec(id, `cat ${shq(i.path)}`);
      if (r.exitCode !== 0) throw httpError(404, `File not found: ${i.path}`);
      const content = i.startLine || i.endLine ? r.stdout.split('\n').slice((i.startLine ?? 1) - 1, i.endLine).join('\n') : r.stdout;
      return { path: i.path, content, sha256: sha256(r.stdout), sizeBytes: Buffer.byteLength(r.stdout), truncated: false };
    }
    if (action === 'files/write') {
      const i = body.input;
      const r = await dexec(id, `mkdir -p "$(dirname ${shq(i.path)})" && cat > ${shq(i.path)}`, { stdin: i.content });
      if (r.exitCode !== 0) throw httpError(500, r.stderr.slice(0, 300));
      return { path: i.path, sha256: sha256(i.content), sizeBytes: Buffer.byteLength(i.content) };
    }
    if (action === 'files/patch') {
      const i = body.input;
      const r = await dexec(id, `git apply --whitespace=nowarn -`, { cwd: i.cwd, stdin: i.patch });
      return { applied: r.exitCode === 0, output: r.stderr || r.stdout, changedFiles: [], rejectedFiles: r.exitCode === 0 ? [] : ['(see output)'], rolledBack: r.exitCode !== 0 };
    }
    if (action === 'files/tree') {
      const i = body.input;
      const r = await dexec(id, `cd ${shq(i.path)} 2>/dev/null && find . -maxdepth ${i.depth ?? 4} -printf '%y %p\\n' 2>/dev/null | head -n ${i.limit ?? 1000}`);
      const entries = r.stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [t, ...rest] = line.split(' ');
        return { path: rest.join(' ').replace(/^\.\//, ''), type: t === 'd' ? 'directory' : t === 'l' ? 'symlink' : 'file' };
      });
      return { entries, truncated: entries.length >= (i.limit ?? 1000) };
    }
    if (action === 'process/start') {
      const i = body.input;
      const log = `/workspace/tmp/proc-${i.processId}.log`;
      const pidf = `/workspace/tmp/proc-${i.processId}.pid`;
      const envExports = Object.entries(i.environment ?? {}).map(([k, v]) => `export ${k}=${shq(v)};`).join(' ');
      // Launch detached, capture the pid, keep logs in a file the log endpoint tails.
      const r = await dexec(id, `cd ${shq(i.cwd)}; ${envExports} nohup bash -lc ${shq(i.command)} > ${shq(log)} 2>&1 < /dev/null & echo $! | tee ${shq(pidf)}`);
      const pid = Number(r.stdout.trim()) || undefined;
      return { id: i.processId, providerProcessId: i.processId, command: i.command, cwd: i.cwd, status: 'running', pid };
    }
    if (action === 'process/get') {
      const processId = body.processId;
      const pidf = `/workspace/tmp/proc-${processId}.pid`;
      const r = await dexec(id, `pid=$(cat ${shq(pidf)} 2>/dev/null); if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "running $pid"; else echo "exited $pid"; fi`);
      const [status, pid] = r.stdout.trim().split(' ');
      return status ? { id: processId, providerProcessId: processId, command: '', cwd: '/workspace', status, pid: Number(pid) || undefined } : null;
    }
    if (action === 'process/logs') {
      const i = body.input;
      const log = `/workspace/tmp/proc-${i.processId}.log`;
      const cursor = Number(i.cursor ?? 0);
      const limit = Number(i.limitBytes ?? 100_000);
      const r = await dexec(id, `tail -c +${cursor + 1} ${shq(log)} 2>/dev/null | head -c ${limit}`);
      const data = r.stdout;
      const bytes = Buffer.byteLength(data);
      return { data, nextCursor: String(cursor + bytes), truncated: bytes >= limit };
    }
    if (action === 'process/stop') {
      const processId = body.processId;
      const pidf = `/workspace/tmp/proc-${processId}.pid`;
      await dexec(id, `pid=$(cat ${shq(pidf)} 2>/dev/null); if [ -n "$pid" ]; then pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null; sleep 0.3; kill -KILL "$pid" 2>/dev/null; fi; true`);
      return {};
    }
    if (action === 'ports/expose') {
      const i = body.input;
      const host = await hostPortFor(id, i.port);
      if (host === null) {
        throw httpError(400, `Port ${i.port} is not published. Publish it via FORGE_AGENT_PREVIEW_PORTS (currently ${PREVIEW_PORTS.join(', ')}).`);
      }
      // The Worker proxies preview traffic to /preview/<providerId>/<port>; the
      // agent resolves the live host port per request. providerUrl is informational.
      return { port: i.port, name: i.name, providerUrl: `http://127.0.0.1:${host}` };
    }
    if (action === 'ports/revoke') return {}; // published for the container's lifetime; destroy frees them
    if (action === 'snapshot') throw httpError(501, 'Snapshots are not supported by the self-hosted backend.');
  }

  if (p === '/v1/browser/capture' || p === '/v1/browser/screenshot' || p === '/v1/browser/accessibility') return render({ input: body.input });
  if (p === '/v1/browser/act') return render({ input: body.input, steps: body.input.steps });
  throw httpError(404, `Unknown route ${method} ${p}`);
}

const shq = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Reap idle containers so a crashed session doesn't hold capacity (Forge's TTL
// also destroys them; this is a local backstop).
setInterval(() => {
  const now = Date.now();
  for (const [id, w] of workspaces) {
    if (now - w.lastActive > IDLE_MS) {
      docker(['rm', '-f', w.name]);
      workspaces.delete(id);
      console.log('forge_agent_reaped_idle', { providerId: id });
    }
  }
}, 60_000).unref();

const server = createServer((req, res) => {
  const send = (status, obj) => {
    const payload = JSON.stringify(obj ?? {});
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  };
  if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) return send(401, { message: 'Unauthorized' });

  // Raw preview proxy: /preview/<providerId>/<containerPort>/<rest> → the live
  // dev server inside the workspace container. Forge (over the tunnel) calls this
  // so browser_act and human viewing can reach a preview on the mini.
  if (req.url.startsWith('/preview/')) {
    const inbound = [];
    req.on('data', (c) => inbound.push(c));
    const m = req.url.match(/^\/preview\/([^/]+)\/(\d+)(\/[^?]*)?(\?.*)?$/);
    if (!m) {
      req.resume();
      return send(404, { message: 'Bad preview path' });
    }
    req.on('end', async () => {
      try {
        const host = await hostPortFor(decodeURIComponent(m[1]), m[2]);
        if (!host) return send(502, { message: 'Preview port not reachable (is the dev server running on a published port?)' });
        const headers = { ...req.headers };
        delete headers.authorization; // never forward the agent token to the app
        delete headers.host;
        delete headers['content-length'];
        const upstream = await fetch(`http://127.0.0.1:${host}${m[3] || '/'}${m[4] || ''}`, {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(inbound),
          redirect: 'manual'
        });
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
        res.end(buf);
      } catch (error) {
        send(502, { message: String(error.message ?? error).slice(0, 200) });
      }
    });
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      return send(400, { message: 'Invalid JSON body' });
    }
    try {
      send(200, await handle(req.method, req.url, body));
    } catch (error) {
      send(error.status ?? 500, { message: String(error.message ?? error).slice(0, 500) });
    }
  });
});

if (process.argv.includes('--selftest')) {
  health().then((h) => {
    console.log(JSON.stringify(h, null, 2));
    process.exit(h.healthy ? 0 : 1);
  });
} else {
  server.listen(PORT, () => console.log(`Forge Node Agent on :${PORT} — image ${IMAGE}, max ${MAX} workspaces (hardened containers)`));
}
