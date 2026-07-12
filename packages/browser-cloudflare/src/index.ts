import puppeteer, { type BrowserWorker } from '@cloudflare/puppeteer';
import type { ArtifactStore } from '@forge/artifacts-core';
import type {
  AccessibilityResult,
  BrowserProvider,
  ScreenshotInput,
  ScreenshotResult
} from '@forge/browser-core';
import { ids, type TenantId } from '@forge/core';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export class CloudflareBrowserProvider implements BrowserProvider {
  constructor(
    private readonly browserBinding: BrowserWorker,
    private readonly artifacts: ArtifactStore,
    private readonly tenantId: TenantId
  ) {}

  async screenshot(input: ScreenshotInput): Promise<ScreenshotResult> {
    const browser = await puppeteer.launch(this.browserBinding);
    try {
      const page = await browser.newPage();
      await page.setViewport(input.viewport);
      if (input.headers) await page.setExtraHTTPHeaders(input.headers);
      await page.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'reduce' }
      ]);
      await page.goto(new URL(input.path, input.url).toString(), {
        waitUntil: 'networkidle0',
        timeout: 30_000
      });
      const bytes = (await page.screenshot({
        type: 'png',
        fullPage: input.fullPage
      })) as Uint8Array;
      const id = ids.artifact();
      const ref = await this.artifacts.put({
        id,
        tenantId: this.tenantId,
        workspaceId: input.workspaceId,
        kind: 'browser.screenshot',
        contentType: 'image/png',
        bytes: toArrayBuffer(bytes),
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
        contentType: 'image/png',
        width: input.viewport.width,
        height: input.viewport.height,
        sha256: ref.sha256
      };
    } finally {
      await browser.close();
    }
  }

  async accessibilityTree(
    input: Omit<ScreenshotInput, 'fullPage'>
  ): Promise<AccessibilityResult> {
    const browser = await puppeteer.launch(this.browserBinding);
    try {
      const page = await browser.newPage();
      await page.setViewport(input.viewport);
      if (input.headers) await page.setExtraHTTPHeaders(input.headers);
      await page.goto(new URL(input.path, input.url).toString(), {
        waitUntil: 'networkidle0',
        timeout: 30_000
      });
      const tree = await page.accessibility.snapshot({ interestingOnly: true });
      return { tree, truncated: false };
    } finally {
      await browser.close();
    }
  }
}
