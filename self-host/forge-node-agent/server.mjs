#!/usr/bin/env node
// Forge Node Agent (reference implementation)
// ------------------------------------------------------------------
// Runs on a self-hosted machine (Mac mini, Linux box, …) and exposes the HTTP
// contract that Forge's SelfHostedSandboxProvider / SelfHostedBrowserProvider
// call. Each workspace runs in an isolated Docker container; browser evidence is
// rendered with a local headless Chromium via Playwright.
//
// Forge only routes work here when POST /v1/health returns { healthy: true }.
// That health check runs a real self-test (docker up + a throwaway container +
// chromium launch), so a broken box fails closed and Forge falls back to
// Cloudflare — the MCP caller never notices.
//
// This is a REFERENCE you can run as-is for the core loop (create / exec /
// read / write / patch / tree / destroy / browser) and extend. Snapshot and a
// few advanced ops return a clear "unsupported" error rather than pretending.
//
// Config via env:
//   FORGE_AGENT_TOKEN   (required)  shared secret; must match FORGE_SELFHOST_TOKEN in Forge
//   FORGE_AGENT_PORT    (default 8787)
//   FORGE_AGENT_IMAGE   (default forge-workspace:latest) base container image
//   FORGE_AGENT_WORKDIR (default /workspace) working root inside the container

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TOKEN = process.env.FORGE_AGENT_TOKEN;
const PORT = Number(process.env.FORGE_AGENT_PORT || 8787);
const IMAGE = process.env.FORGE_AGENT_IMAGE || 'forge-workspace:latest';
const WORKDIR = process.env.FORGE_AGENT_WORKDIR || '/workspace';

if (!TOKEN) {
  console.error('FORGE_AGENT_TOKEN is required.');
  process.exit(1);
}

// ---- helpers ----------------------------------------------------------------
async function docker(args, opts = {}) {
  return run('docker', args, { maxBuffer: 64 * 1024 * 1024, ...opts });
}
const containerName = (providerId) => `forge-${String(providerId).replace(/[^a-z0-9_.-]/gi, '').slice(0, 60)}`;

async function inContainer(providerId, command, { cwd = WORKDIR, timeoutMs = 120_000 } = {}) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await docker(
      ['exec', '-w', cwd, containerName(providerId), 'bash', '-lc', command],
      { timeout: timeoutMs }
    );
    return { exitCode: 0, stdout, stderr, truncated: false, durationMs: Date.now() - started, artifactRefs: [] };
  } catch (error) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error.message ?? error),
      truncated: false,
      durationMs: Date.now() - started,
      artifactRefs: []
    };
  }
}

async function sha256(text) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text, 'utf8').digest('hex');
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
    const url = new URL((input.path || '/').replace(/^\/+/, ''), input.url.endsWith('/') ? input.url : `${input.url}/`).toString();
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
    return {
      screenshotBase64: jpeg.toString('base64'),
      contentType: 'image/jpeg',
      accessibilityTree: tree,
      finalUrl: page.url(),
      width: input.viewport?.width,
      height: input.viewport?.height
    };
  } finally {
    await context.close();
  }
}

// ---- health / self-test -----------------------------------------------------
async function health() {
  const checks = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail });
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error.message ?? error).slice(0, 200) });
    }
  };
  await check('docker', async () => (await docker(['version', '--format', '{{.Server.Version}}'])).stdout.trim());
  await check('image', async () => {
    await docker(['image', 'inspect', IMAGE]);
    return IMAGE;
  });
  await check('container-run', async () => {
    const { stdout } = await docker(['run', '--rm', IMAGE, 'bash', '-lc', 'echo ok'], { timeout: 60_000 });
    if (!stdout.includes('ok')) throw new Error('self-test container did not echo ok');
    return 'ran throwaway container';
  });
  await check('chromium', async () => {
    const b = await chromium();
    const ctx = await b.newContext();
    await ctx.close();
    return 'launched';
  });
  await check('disk', async () => {
    const { stdout } = await run('df', ['-h', '/']);
    return stdout.trim().split('\n').pop();
  });
  return { healthy: checks.every((c) => c.ok), checks };
}

// ---- request routing --------------------------------------------------------
async function handle(method, path, body) {
  // Sandbox lifecycle
  if (path === '/v1/health') return health();
  if (path === '/v1/browser/health') {
    try {
      const b = await chromium();
      const ctx = await b.newContext();
      await ctx.close();
      return { healthy: true };
    } catch {
      return { healthy: false };
    }
  }
  if (path === '/v1/sandboxes') {
    const { input } = body;
    const name = containerName(input.providerId);
    await docker(['rm', '-f', name]).catch(() => undefined);
    await docker(['run', '-d', '--name', name, '--label', 'forge=1', '-w', WORKDIR, IMAGE, 'sleep', 'infinity']);
    await inContainer(input.providerId, `mkdir -p ${WORKDIR}/repo ${WORKDIR}/tmp`);
    return { providerId: input.providerId };
  }
  const sandboxMatch = path.match(/^\/v1\/sandboxes\/([^/]+)\/(.+)$/);
  if (sandboxMatch) {
    const providerId = decodeURIComponent(sandboxMatch[1]);
    const action = sandboxMatch[2];
    if (action === 'destroy') {
      await docker(['rm', '-f', containerName(providerId)]).catch(() => undefined);
      return {};
    }
    if (action === 'suspend') return void (await docker(['pause', containerName(providerId)])) ?? {};
    if (action === 'resume') return void (await docker(['unpause', containerName(providerId)])) ?? {};
    if (action === 'exec') {
      const i = body.input;
      const cmd = i.stdin ? `printf %s ${shq(i.stdin)} | ${i.command}` : i.command;
      return inContainer(providerId, cmd, { cwd: i.cwd, timeoutMs: i.timeoutMs });
    }
    if (action === 'files/read') {
      const i = body.input;
      const res = await inContainer(providerId, `cat ${shq(i.path)}`);
      if (res.exitCode !== 0) throw httpError(404, `File not found: ${i.path}`);
      const content = i.startLine || i.endLine ? res.stdout.split('\n').slice((i.startLine ?? 1) - 1, i.endLine).join('\n') : res.stdout;
      return { path: i.path, content, sha256: await sha256(res.stdout), sizeBytes: Buffer.byteLength(res.stdout), truncated: false };
    }
    if (action === 'files/write') {
      const i = body.input;
      await inContainer(providerId, `mkdir -p "$(dirname ${shq(i.path)})" && cat > ${shq(i.path)} <<'FORGE_EOF'\n${i.content}\nFORGE_EOF`);
      return { path: i.path, sha256: await sha256(i.content), sizeBytes: Buffer.byteLength(i.content) };
    }
    if (action === 'files/patch') {
      const i = body.input;
      const apply = await inContainer(providerId, `cd ${shq(i.cwd)} && git apply --whitespace=nowarn - <<'FORGE_EOF'\n${i.patch}\nFORGE_EOF`);
      return { applied: apply.exitCode === 0, output: apply.stderr || apply.stdout, changedFiles: [], rejectedFiles: apply.exitCode === 0 ? [] : ['(see output)'], rolledBack: apply.exitCode !== 0 };
    }
    if (action === 'files/tree') {
      const i = body.input;
      const res = await inContainer(providerId, `cd ${shq(i.path)} 2>/dev/null && find . -maxdepth ${i.depth ?? 4} -printf '%y %p\\n' | head -n ${i.limit ?? 1000}`);
      const entries = res.stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [t, ...rest] = line.split(' ');
        return { path: rest.join(' ').replace(/^\.\//, ''), type: t === 'd' ? 'directory' : t === 'l' ? 'symlink' : 'file' };
      });
      return { entries, truncated: entries.length >= (i.limit ?? 1000) };
    }
    if (action === 'ports/expose') throw httpError(501, 'Preview port exposure is not implemented in the reference agent.');
    if (action.startsWith('process/')) throw httpError(501, 'Background processes are not implemented in the reference agent.');
    if (action === 'snapshot') throw httpError(501, 'Snapshots are not supported by the self-hosted backend.');
  }
  // Browser
  if (path === '/v1/browser/capture' || path === '/v1/browser/screenshot' || path === '/v1/browser/accessibility') {
    return render({ input: body.input });
  }
  if (path === '/v1/browser/act') return render({ input: body.input, steps: body.input.steps });
  throw httpError(404, `Unknown route ${method} ${path}`);
}

function shq(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---- server -----------------------------------------------------------------
const server = createServer((req, res) => {
  const send = (status, obj) => {
    const payload = JSON.stringify(obj);
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
      const result = await handle(req.method, req.url.split('?')[0], body);
      send(200, result ?? {});
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
  server.listen(PORT, () => console.log(`Forge Node Agent listening on :${PORT} (image ${IMAGE})`));
}
