import type { ArtifactStore } from '@forge/artifacts-core';
import {
  analyzeStructureHealth,
  type AccessibilityResult,
  type BrowserActInput,
  type BrowserActResult,
  type BrowserEvidenceResult,
  type BrowserProvider,
  type ImageContentType,
  type ScreenshotInput,
  type ScreenshotResult
} from '@forge/browser-core';
import { ids, type TenantId } from '@forge/core';

// Browser evidence rendered by the self-hosted agent's Chrome. Chrome on a
// personal machine is flaky, so the caller health-checks the agent first and
// falls back to Cloudflare Browser Run; this provider only runs once selected.
// The agent renders the page and returns a base64 image + accessibility tree;
// we persist the image to R2 exactly like the Cloudflare provider so the rest of
// Forge is unaffected by which backend produced it.

export interface SelfHostedBrowserConfig {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface AgentRenderResult {
  screenshotBase64: string;
  contentType?: ImageContentType;
  accessibilityTree: unknown;
  finalUrl?: string;
  width?: number;
  height?: number;
}

async function agentRender(
  config: SelfHostedBrowserConfig,
  path: string,
  body: unknown
): Promise<AgentRenderResult> {
  const doFetch = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 120_000);
  try {
    const response = await doFetch(`${config.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`agent browser ${path} HTTP ${response.status}`);
    return (await response.json()) as AgentRenderResult;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value.replace(/^data:image\/[^;]+;base64,/, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export class SelfHostedBrowserProvider implements BrowserProvider {
  constructor(
    private readonly config: SelfHostedBrowserConfig,
    private readonly artifacts: ArtifactStore,
    private readonly tenantId: TenantId
  ) {}

  async healthy(): Promise<boolean> {
    try {
      const doFetch = this.config.fetchImpl ?? fetch;
      const response = await doFetch(`${this.config.baseUrl.replace(/\/+$/, '')}/v1/browser/health`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' },
        body: '{}'
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { healthy?: boolean };
      return Boolean(body.healthy);
    } catch {
      return false;
    }
  }

  private async store(input: ScreenshotInput, render: AgentRenderResult): Promise<ScreenshotResult> {
    const contentType: ImageContentType = render.contentType ?? 'image/jpeg';
    const bytes = decodeBase64(render.screenshotBase64);
    const id = ids.artifact();
    const ref = await this.artifacts.put({
      id,
      tenantId: this.tenantId,
      workspaceId: input.workspaceId,
      kind: 'browser.screenshot',
      contentType,
      bytes,
      metadata: {
        path: input.path,
        width: render.width ?? input.viewport.width,
        height: render.height ?? input.viewport.height,
        operationId: input.operationId,
        repositoryCommit: input.repositoryCommit,
        workspaceRevision: input.workspaceRevision
      }
    });
    return {
      artifactId: id,
      contentType,
      width: render.width ?? input.viewport.width,
      height: render.height ?? input.viewport.height,
      sha256: ref.sha256,
      sizeBytes: bytes.byteLength,
      inline: { base64: render.screenshotBase64.replace(/^data:image\/[^;]+;base64,/, ''), contentType }
    };
  }

  private accessibility(render: AgentRenderResult): AccessibilityResult {
    return {
      tree: render.accessibilityTree,
      truncated: false,
      structure: analyzeStructureHealth(render.accessibilityTree)
    };
  }

  async captureEvidence(input: ScreenshotInput): Promise<BrowserEvidenceResult> {
    const render = await agentRender(this.config, '/v1/browser/capture', { input });
    return { screenshot: await this.store(input, render), accessibility: this.accessibility(render) };
  }

  async act(input: BrowserActInput): Promise<BrowserActResult> {
    const render = await agentRender(this.config, '/v1/browser/act', { input });
    return {
      screenshot: await this.store(input, render),
      accessibility: this.accessibility(render),
      stepsExecuted: input.steps.length,
      finalUrl: render.finalUrl
    };
  }

  async screenshot(input: ScreenshotInput): Promise<ScreenshotResult> {
    const render = await agentRender(this.config, '/v1/browser/screenshot', { input });
    return this.store(input, render);
  }

  async accessibilityTree(input: Omit<ScreenshotInput, 'fullPage'>): Promise<AccessibilityResult> {
    const render = await agentRender(this.config, '/v1/browser/accessibility', { input: { ...input, fullPage: false } });
    return this.accessibility(render);
  }
}
