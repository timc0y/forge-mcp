import type { ArtifactStore } from '@forge/artifacts-core';
import type {
  AccessibilityResult,
  BrowserActInput,
  BrowserActResult,
  BrowserActionStep,
  BrowserEvidenceResult,
  BrowserProvider,
  ImageContentType,
  ScreenshotInput,
  ScreenshotResult
} from '@forge/browser-core';
import { analyzeStructureHealth } from '@forge/browser-core';
import { ids, type TenantId } from '@forge/core';
import puppeteer, {
  type Page,
  type Page as PuppeteerPage,
  type Browser as PuppeteerBrowser
} from '@cloudflare/puppeteer';

interface SnapshotResponse {
  success: boolean;
  result?: {
    screenshot?: string;
    accessibilityTree?: unknown;
    url?: string;
  };
  errors?: Array<{ message?: string; code?: number }>;
}

type SnapshotOptions = BrowserRunSnapshotOptions & {
  formats: Array<'screenshot' | 'markdown' | 'accessibilityTree'>;
};

// Evidence screenshots default to JPEG: 3-10× smaller than PNG end-to-end (R2
// storage, response payload, Worker base64 CPU, client tokens) at a fidelity
// that still supports visual review. Callers pass format: 'image/png' when they
// need lossless pixels.
const DEFAULT_IMAGE: ImageContentType = 'image/jpeg';
const DEFAULT_JPEG_QUALITY = 80;
// The two evidence formats Forge actually consumes. `markdown` was requested
// historically but never read, so it is dropped to shrink each snapshot.
const EVIDENCE_FORMATS: SnapshotOptions['formats'] = ['screenshot', 'accessibilityTree'];

function imageType(input: Pick<ScreenshotInput, 'format'>): { contentType: ImageContentType; type: 'png' | 'jpeg' } {
  const contentType = input.format ?? DEFAULT_IMAGE;
  return { contentType, type: contentType === 'image/png' ? 'png' : 'jpeg' };
}

function screenshotOptions(input: ScreenshotInput): Record<string, unknown> {
  const { type } = imageType(input);
  const options: Record<string, unknown> = { type, fullPage: input.fullPage };
  if (type === 'jpeg') options.quality = input.quality ?? DEFAULT_JPEG_QUALITY;
  return options;
}

function targetUrl(input: Pick<ScreenshotInput, 'url' | 'path'>): string {
  const base = new URL(input.url.endsWith('/') ? input.url : `${input.url}/`);
  return new URL(input.path.replace(/^\/+/, ''), base).toString();
}

function baseOptions(input: Omit<ScreenshotInput, 'fullPage'>): BrowserRunBaseOptions & { url: string } {
  return {
    url: targetUrl(input),
    setExtraHTTPHeaders: input.headers,
    viewport: input.viewport,
    gotoOptions: { waitUntil: 'domcontentloaded', timeout: 30_000 },
    cacheTTL: input.cacheTtlSeconds ?? 0,
    actionTimeout: 60_000
  };
}

// Drive Forge's bounded action vocabulary against a real Puppeteer page. The
// Browser Run REST `/snapshot` endpoint does not accept interaction steps
// (it rejects an `actions` key), so multi-step journeys run through the
// @cloudflare/puppeteer binding instead — the only path that actually clicks,
// types, and waits before capturing evidence.
async function runStep(page: Page, step: BrowserActionStep, base: URL): Promise<void> {
  switch (step.kind) {
    case 'navigate':
      await page.goto(new URL(step.path.replace(/^\/+/, ''), base).toString(), {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      });
      return;
    case 'click':
      await page.click(step.selector);
      return;
    case 'fill':
      await page.type(step.selector, step.value);
      return;
    case 'press':
      await page.keyboard.press(step.key as Parameters<typeof page.keyboard.press>[0]);
      return;
    case 'wait_for_selector':
      await page.waitForSelector(step.selector, { timeout: step.timeoutMs ?? 10_000 });
      return;
    case 'wait_for_text':
      // Runs in the page context; `document` is typed via globalThis so this
      // compiles under the Worker lib (no DOM types) without leaking `any`.
      await page.waitForFunction(
        (text: string) =>
          (
            (globalThis as unknown as { document?: { body?: { innerText?: string } | null } })
              .document?.body?.innerText ?? ''
          ).includes(text),
        { timeout: step.timeoutMs ?? 10_000 },
        step.text
      );
      return;
    case 'wait':
      await new Promise((resolve) => setTimeout(resolve, step.timeoutMs));
      return;
    case 'reload':
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      return;
  }
}

function stripDataPrefix(value: string): string {
  return value.replace(/^data:image\/[^;]+;base64,/, '');
}

// Puppeteer's screenshot() returns a Uint8Array (binary) or a base64 string
// depending on encoding; normalize both to the ArrayBuffer storeScreenshot wants.
function toArrayBuffer(shot: Uint8Array | string): ArrayBuffer {
  if (typeof shot === 'string') return decodeBase64(shot);
  return shot.buffer.slice(shot.byteOffset, shot.byteOffset + shot.byteLength) as ArrayBuffer;
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(stripDataPrefix(value));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

// Chunked base64 avoids the quadratic per-character string building that a naive
// loop incurs on multi-MB images running on the CPU-metered Worker isolate.
function encodeBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < view.length; index += chunk) {
    binary += String.fromCharCode(...view.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export class CloudflareBrowserProvider implements BrowserProvider {
  constructor(
    private readonly browserBinding: BrowserRun,
    private readonly artifacts: ArtifactStore,
    private readonly tenantId: TenantId
  ) {}

  // Persist to R2 and attach the freshly captured image inline so the caller can
  // return it without a second R2 GET. `originalBase64` (as returned by Browser
  // Run) is reused verbatim for the inline copy — no decode/re-encode round trip.
  private async storeScreenshot(
    input: ScreenshotInput,
    bytes: ArrayBuffer,
    originalBase64?: string
  ): Promise<ScreenshotResult> {
    const id = ids.artifact();
    const { contentType } = imageType(input);
    const ref = await this.artifacts.put({
      id,
      tenantId: this.tenantId,
      workspaceId: input.workspaceId,
      kind: 'browser.screenshot',
      contentType,
      bytes,
      metadata: {
        path: input.path,
        width: input.viewport.width,
        height: input.viewport.height,
        operationId: input.operationId,
        repositoryCommit: input.repositoryCommit,
        workspaceRevision: input.workspaceRevision
      }
    });
    return {
      artifactId: id,
      contentType,
      width: input.viewport.width,
      height: input.viewport.height,
      sha256: ref.sha256,
      sizeBytes: bytes.byteLength,
      inline: { base64: originalBase64 ? stripDataPrefix(originalBase64) : encodeBase64(bytes), contentType }
    };
  }

  private async snapshot(
    input: ScreenshotInput,
    formats: SnapshotOptions['formats']
  ): Promise<SnapshotResponse['result']> {
    const options: SnapshotOptions = {
      ...baseOptions(input),
      formats,
      screenshotOptions: screenshotOptions(input)
    };
    return this.snapshotWithOptions(options as BrowserRunSnapshotOptions, input.deadlineAt);
  }

  private async snapshotWithOptions(
    options: BrowserRunSnapshotOptions,
    deadlineAt?: number
  ): Promise<SnapshotResponse['result']> {
    const pastDeadline = () => deadlineAt !== undefined && Date.now() >= deadlineAt;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response: Response;
      try {
        response = await this.browserBinding.quickAction(
          'snapshot',
          options as BrowserRunSnapshotOptions
        );
      } catch (error) {
        if (attempt < 3 && !pastDeadline()) {
          await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
          continue;
        }
        console.error('forge_browser_snapshot_exception', {
          name: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message.slice(0, 500) : 'unknown'
        });
        throw error;
      }
      const body = await response.text();
      let payload: SnapshotResponse;
      try {
        payload = JSON.parse(body) as SnapshotResponse;
      } catch {
        console.error('forge_browser_snapshot_invalid_response', {
          status: response.status,
          contentType: response.headers.get('content-type'),
          body: body.slice(0, 500)
        });
        throw new Error('Browser Run snapshot returned an invalid response.');
      }
      if (response.ok && payload.success && payload.result) return payload.result;
      // Only Browser Run's concurrency-limit error (5006) is worth retrying;
      // other failures are terminal and retrying just burns the deadline.
      const retryable = payload.errors?.some((error) => error.code === 5006) ?? false;
      if (retryable && attempt < 3 && !pastDeadline()) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
        continue;
      }
      const reason = payload.errors?.map((error) => error.message).filter(Boolean).join('; ');
      console.error('forge_browser_snapshot_failed', {
        status: response.status,
        errors: payload.errors?.slice(0, 5)
      });
      throw new Error(`Browser Run snapshot failed${reason ? `: ${reason}` : '.'}`);
    }
    throw new Error('Browser Run snapshot retry budget was exhausted.');
  }

  async captureEvidence(input: ScreenshotInput): Promise<BrowserEvidenceResult> {
    const result = await this.snapshot(input, EVIDENCE_FORMATS);
    if (!result?.screenshot || result.accessibilityTree === undefined) {
      console.error('forge_browser_snapshot_missing_formats', {
        resultKeys: result ? Object.keys(result) : []
      });
      throw new Error('Browser Run snapshot omitted required evidence formats.');
    }
    return {
      screenshot: await this.storeScreenshot(input, decodeBase64(result.screenshot), result.screenshot),
      accessibility: {
        tree: result.accessibilityTree,
        truncated: false,
        structure: analyzeStructureHealth(result.accessibilityTree)
      }
    };
  }

  // Reuse a warm Browser Rendering session when one is free (far faster than a
  // cold launch, and avoids leaking a new session per call), else launch one
  // with a short keep-alive so idle sessions self-close.
  private async acquireBrowser(): Promise<PuppeteerBrowser> {
    const binding = this.browserBinding as unknown as Parameters<typeof puppeteer.launch>[0];
    try {
      const sessions = await puppeteer.sessions(binding);
      const free = sessions.find((session) => !session.connectionId);
      if (free) return await puppeteer.connect(binding, free.sessionId);
    } catch {
      // No reusable session (or the API is unavailable) — fall through to launch.
    }
    return await puppeteer.launch(binding, { keep_alive: 60_000 });
  }

  async act(input: BrowserActInput): Promise<BrowserActResult> {
    const base = new URL(input.url.endsWith('/') ? input.url : `${input.url}/`);
    const { contentType } = imageType(input);
    // Interaction steps require a real driven page — run them through the
    // Puppeteer binding, then capture the screenshot + accessibility tree from
    // the resulting post-interaction state. Bounded so a bad selector can never
    // hang the whole capture; the session is kept warm (disconnect, not close).
    const budgetMs = Math.max(
      5_000,
      Math.min(45_000, input.deadlineAt ? input.deadlineAt - Date.now() : 45_000)
    );
    const browser = await this.acquireBrowser();
    let page: PuppeteerPage | undefined;
    const drive = async (): Promise<BrowserActResult> => {
      page = await browser.newPage();
      await page.setViewport({ width: input.viewport.width, height: input.viewport.height });
      if (input.headers) await page.setExtraHTTPHeaders(input.headers);
      await page.goto(base.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      for (const step of input.steps) await runStep(page, step, base);
      const shot = await page.screenshot({
        type: contentType === 'image/png' ? 'png' : 'jpeg',
        ...(contentType === 'image/jpeg' ? { quality: input.quality ?? 80 } : {}),
        fullPage: input.fullPage
      });
      const tree = await page.accessibility.snapshot();
      const finalUrl = page.url();
      return {
        screenshot: await this.storeScreenshot(input, toArrayBuffer(shot)),
        accessibility: { tree: tree ?? null, truncated: false, structure: analyzeStructureHealth(tree) },
        stepsExecuted: input.steps.length,
        finalUrl
      };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        drive(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Interaction run exceeded ${budgetMs}ms.`)), budgetMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (page) await page.close().catch(() => undefined);
      // Keep the remote session alive for the next capture rather than tearing
      // it down; idle sessions self-close after keep_alive.
      browser.disconnect();
    }
  }

  async screenshot(input: ScreenshotInput): Promise<ScreenshotResult> {
    const response = await this.browserBinding.quickAction('screenshot', {
      ...baseOptions(input),
      screenshotOptions: screenshotOptions(input)
    });
    if (!response.ok) throw new Error(`Browser Run screenshot failed with HTTP ${response.status}.`);
    return this.storeScreenshot(input, await response.arrayBuffer());
  }

  async accessibilityTree(
    input: Omit<ScreenshotInput, 'fullPage'>
  ): Promise<AccessibilityResult> {
    const result = await this.snapshot({ ...input, fullPage: false }, ['accessibilityTree']);
    if (result?.accessibilityTree === undefined) {
      console.error('forge_browser_snapshot_missing_accessibility', {
        resultKeys: result ? Object.keys(result) : []
      });
      throw new Error('Browser Run snapshot omitted the accessibility tree.');
    }
    return {
      tree: result.accessibilityTree,
      truncated: false,
      structure: analyzeStructureHealth(result.accessibilityTree)
    };
  }
}
