#!/usr/bin/env node
// Optional self-hosted browser evidence for Forge. Repository execution always
// uses the Cloudflare Sandbox provider; this process only renders public preview
// URLs with a local Chromium and falls back to Browser Run when unhealthy.

import { createServer } from 'node:http';

const TOKEN = process.env.FORGE_AGENT_TOKEN;
const PORT = Number(process.env.FORGE_AGENT_PORT || 8787);

if (!TOKEN) {
  console.error('FORGE_AGENT_TOKEN is required.');
  process.exit(1);
}

let browserPromise = null;
async function chromium() {
  if (!browserPromise) {
    const { chromium: playwrightChromium } = await import('playwright');
    browserPromise = playwrightChromium.launch({ headless: true });
  }
  return browserPromise;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Forge only routes public preview origins here. Keep an independent SSRF guard
// so a misconfigured caller cannot turn the owner machine into a LAN proxy.
function assertPublicTarget(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    throw httpError(400, 'Invalid preview URL.');
  }
  const blocked =
    host === 'localhost' || host === '0.0.0.0' || host === '::1' ||
    host.endsWith('.internal') || host.endsWith('.local') ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw httpError(403, `Refusing to render a private/loopback address (${host}).`);
}

async function render({ input, steps }) {
  assertPublicTarget(input.url);
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
    await page
      .waitForFunction(() => Array.from(document.images).every((image) => image.complete), { timeout: 5_000 })
      .catch(() => {});
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

async function healthy() {
  try {
    const context = await (await chromium()).newContext();
    await context.close();
    return true;
  } catch {
    return false;
  }
}

async function handle(path, body) {
  if (path === '/v1/browser/health') return { healthy: await healthy() };
  if (path === '/v1/browser/capture' || path === '/v1/browser/screenshot' || path === '/v1/browser/accessibility') {
    return render({ input: body.input });
  }
  if (path === '/v1/browser/act') return render({ input: body.input, steps: body.input.steps });
  throw httpError(404, `Unknown route ${path}`);
}

const server = createServer((request, response) => {
  const send = (status, value) => {
    const payload = JSON.stringify(value ?? {});
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    response.end(payload);
  };
  if ((request.headers.authorization ?? '') !== `Bearer ${TOKEN}`) {
    request.resume();
    return send(401, { message: 'Unauthorized' });
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', async () => {
    let body = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      return send(400, { message: 'Invalid JSON body' });
    }
    try {
      send(200, await handle(request.url.split('?')[0], body));
    } catch (error) {
      send(error.status ?? 500, { message: String(error.message ?? error).slice(0, 500) });
    }
  });
});

if (process.argv.includes('--selftest')) {
  healthy().then((ok) => {
    console.log(JSON.stringify({ healthy: ok, checks: [{ name: 'chromium', ok }] }, null, 2));
    process.exit(ok ? 0 : 1);
  });
} else {
  server.listen(PORT, () => console.log(`Forge browser agent on :${PORT}`));
}
