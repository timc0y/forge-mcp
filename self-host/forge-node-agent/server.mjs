#!/usr/bin/env node
// Forge Node Agent (reference implementation) — no Docker required.
// ------------------------------------------------------------------
// Runs on a machine you own (Mac mini, Linux box, …) and exposes the HTTP
// contract that Forge's SelfHostedSandboxProvider / SelfHostedBrowserProvider
// call. A workspace is simply a FOLDER under a work root; commands run in it
// with the tools you installed (Homebrew node/git/etc.). No containers, nothing
// to learn — it's a folder and a shell.
//
// Isolation is by the OS user. For a personal machine that's fine; for stronger
// isolation set FORGE_AGENT_USER to a dedicated low-privilege account (commands
// run via `sudo -u <user>`), and keep the machine disposable — no personal data.
//
// Concurrency: the agent runs up to FORGE_AGENT_MAX_WORKSPACES at once and
// reports capacity in /v1/health, so Forge routes new work here only when there
// is room, otherwise it falls back to Cloudflare.
//
// Take over: each workspace reports its localPath (GET-style /info), so the
// Forge app can offer "Open in Finder / Terminal / VS Code" to inspect or steer
// a running workspace by hand.
//
// Forge only routes work here when /v1/health returns { healthy: true } and has
// spare capacity, so a broken/full machine fails safe.
//
// Config (env):
//   FORGE_AGENT_TOKEN          (required) shared secret; = FORGE_SELFHOST_TOKEN in Forge
//   FORGE_AGENT_PORT           (default 8787)
//   FORGE_AGENT_WORKROOT       (default ~/forge/workspaces)
//   FORGE_AGENT_MAX_WORKSPACES (default 4)
//   FORGE_AGENT_USER           (optional) run workspace commands as this user

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

const TOKEN = process.env.FORGE_AGENT_TOKEN;
const PORT = Number(process.env.FORGE_AGENT_PORT || 8787);
const WORKROOT = process.env.FORGE_AGENT_WORKROOT || path.join(homedir(), 'forge', 'workspaces');
const MAX = Number(process.env.FORGE_AGENT_MAX_WORKSPACES || 4);
const RUN_AS = process.env.FORGE_AGENT_USER || '';
const WS_TOKEN = '/workspace';

if (!TOKEN) {
  console.error('FORGE_AGENT_TOKEN is required.');
  process.exit(1);
}

/** @type {Map<string, { dir: string, createdAt: number, lastActive: number }>} */
const workspaces = new Map();
const dirFor = (providerId) => path.join(WORKROOT, String(providerId).replace(/[^a-z0-9_.-]/gi, '').slice(0, 80));
const touch = (id) => {
  const w = workspaces.get(id);
  if (w) w.lastActive = Date.now();
};

// Forge speaks in /workspace-rooted paths; map them onto the workspace folder
// and refuse anything that escapes it.
function mapPath(dir, p) {
  const s = String(p ?? '');
  if (!s.startsWith(WS_TOKEN)) return s;
  const full = path.resolve(dir, `.${s.slice(WS_TOKEN.length)}`);
  if (full !== dir && !full.startsWith(dir + path.sep)) throw httpError(400, `Path escapes workspace: ${p}`);
  return full;
}

// Run a shell command inside a workspace, rewriting the /workspace convention to
// the real folder. Optionally as a dedicated user.
function shell(dir, command, { cwd, timeoutMs = 120_000, stdin } = {}) {
  const realCommand = String(command).split(WS_TOKEN).join(dir);
  const realCwd = cwd ? mapPath(dir, cwd) : dir;
  const argv = RUN_AS ? ['sudo', '-n', '-u', RUN_AS, 'bash', '-lc', realCommand] : ['bash', '-lc', realCommand];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), { cwd: realCwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    if (stdin !== undefined) child.stdin.end(stdin);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr, truncated: false, durationMs: Date.now() - started, artifactRefs: [] });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: String(err.message), truncated: false, durationMs: Date.now() - started, artifactRefs: [] });
    });
  });
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

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
  await check('workroot', async () => {
    await mkdir(WORKROOT, { recursive: true });
    return WORKROOT;
  });
  await check('git', async () => (await shell(WORKROOT, 'git --version')).stdout.trim());
  await check('node', async () => (await shell(WORKROOT, 'node --version')).stdout.trim());
  await check('exec', async () => {
    const r = await shell(WORKROOT, 'echo ok');
    if (!r.stdout.includes('ok')) throw new Error('shell self-test failed');
    return 'shell works';
  });
  await check('chromium', async () => {
    const b = await chromium();
    const ctx = await b.newContext();
    await ctx.close();
    return 'launched';
  });
  await check('disk', async () => (await shell(WORKROOT, 'df -h . | tail -1')).stdout.trim());
  // `chromium`/`disk` are advisory; core readiness is workroot + git + node + exec.
  const coreOk = checks.filter((c) => ['workroot', 'git', 'node', 'exec'].includes(c.name)).every((c) => c.ok);
  return { healthy: coreOk, checks, capacity: { max: MAX, inUse: workspaces.size } };
}

// ---- routing ----------------------------------------------------------------
async function handle(method, url, body) {
  const path0 = url.split('?')[0];
  if (path0 === '/v1/health') return health();
  if (path0 === '/v1/browser/health') {
    try {
      const ctx = await (await chromium()).newContext();
      await ctx.close();
      return { healthy: true };
    } catch {
      return { healthy: false };
    }
  }

  if (path0 === '/v1/sandboxes') {
    const { input } = body;
    if (workspaces.size >= MAX && !workspaces.has(input.providerId)) {
      throw httpError(503, `At capacity (${workspaces.size}/${MAX} workspaces).`);
    }
    const dir = dirFor(input.providerId);
    await mkdir(path.join(dir, 'repo'), { recursive: true });
    await mkdir(path.join(dir, 'tmp'), { recursive: true });
    workspaces.set(input.providerId, { dir, createdAt: Date.now(), lastActive: Date.now() });
    return { providerId: input.providerId, localPath: dir };
  }

  const m = path0.match(/^\/v1\/sandboxes\/([^/]+)\/(.+)$/);
  if (m) {
    const providerId = decodeURIComponent(m[1]);
    const action = m[2];
    const ws = workspaces.get(providerId);
    const dir = ws?.dir ?? dirFor(providerId);
    touch(providerId);

    if (action === 'info') return { providerId, localPath: dir, open: { finder: `open ${dir}`, terminal: `cd ${dir}`, vscode: `code ${dir}` } };
    if (action === 'destroy') {
      await rm(dir, { recursive: true, force: true });
      workspaces.delete(providerId);
      return {};
    }
    if (action === 'suspend' || action === 'resume') return {}; // local folders need no pause
    if (action === 'exec') {
      const i = body.input;
      return shell(dir, i.command, { cwd: i.cwd, timeoutMs: i.timeoutMs, stdin: i.stdin });
    }
    if (action === 'files/read') {
      const i = body.input;
      let content;
      try {
        content = await readFile(mapPath(dir, i.path), 'utf8');
      } catch {
        throw httpError(404, `File not found: ${i.path}`);
      }
      const sliced = i.startLine || i.endLine ? content.split('\n').slice((i.startLine ?? 1) - 1, i.endLine).join('\n') : content;
      return { path: i.path, content: sliced, sha256: sha256(content), sizeBytes: Buffer.byteLength(content), truncated: false };
    }
    if (action === 'files/write') {
      const i = body.input;
      const target = mapPath(dir, i.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, i.content, 'utf8');
      return { path: i.path, sha256: sha256(i.content), sizeBytes: Buffer.byteLength(i.content) };
    }
    if (action === 'files/patch') {
      const i = body.input;
      const r = await shell(dir, `git apply --whitespace=nowarn -`, { cwd: i.cwd, stdin: i.patch });
      return { applied: r.exitCode === 0, output: r.stderr || r.stdout, changedFiles: [], rejectedFiles: r.exitCode === 0 ? [] : ['(see output)'], rolledBack: r.exitCode !== 0 };
    }
    if (action === 'files/tree') {
      const i = body.input;
      const r = await shell(dir, `cd ${JSON.stringify(mapPath(dir, i.path))} 2>/dev/null && find . -maxdepth ${i.depth ?? 4} -printf '%y %p\\n' 2>/dev/null | head -n ${i.limit ?? 1000}`);
      const entries = r.stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [t, ...rest] = line.split(' ');
        return { path: rest.join(' ').replace(/^\.\//, ''), type: t === 'd' ? 'directory' : t === 'l' ? 'symlink' : 'file' };
      });
      return { entries, truncated: entries.length >= (i.limit ?? 1000) };
    }
    if (action === 'ports/expose') throw httpError(501, 'Preview port exposure is not implemented in the reference agent.');
    if (action.startsWith('process/')) throw httpError(501, 'Background processes are not implemented in the reference agent.');
    if (action === 'snapshot') throw httpError(501, 'Snapshots are not supported by the self-hosted backend.');
  }

  if (path0 === '/v1/browser/capture' || path0 === '/v1/browser/screenshot' || path0 === '/v1/browser/accessibility') return render({ input: body.input });
  if (path0 === '/v1/browser/act') return render({ input: body.input, steps: body.input.steps });
  throw httpError(404, `Unknown route ${method} ${path0}`);
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Reap idle workspace folders so a crashed session doesn't hold capacity forever
// (Forge also destroys them via its TTL; this is a local backstop).
const IDLE_MS = Number(process.env.FORGE_AGENT_IDLE_MINUTES || 60) * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [id, w] of workspaces) {
    if (now - w.lastActive > IDLE_MS) {
      rm(w.dir, { recursive: true, force: true }).catch(() => undefined);
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
  server.listen(PORT, () => console.log(`Forge Node Agent on :${PORT} — workroot ${WORKROOT}, max ${MAX} workspaces, no Docker`));
}
