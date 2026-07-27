import { describe, expect, it, vi } from 'vitest';
import { SelfHostedBrowserProvider, type SelfHostedBrowserConfig } from '@forge/browser-selfhosted';
import type { ArtifactStore } from '@forge/artifacts-core';
import type { ScreenshotInput } from '@forge/browser-core';
import type { TenantId, WorkspaceId, ArtifactId } from '@forge/core';

describe('SelfHostedBrowserProvider', () => {
  const mockArtifacts: ArtifactStore = {
    async put(input) {
      return {
        id: input.id,
        key: `key/${input.id}`,
        contentType: input.contentType,
        sizeBytes: input.bytes.byteLength,
        sha256: 'mock-sha256'
      };
    },
    async get() {
      return null;
    },
    async deleteWorkspace() {}
  };

  const sampleInput: ScreenshotInput = {
    workspaceId: 'wsp_1234567890123456789012' as WorkspaceId,
    url: 'http://localhost:3000',
    path: '/',
    viewport: { id: 'desktop', width: 1280, height: 800 },
    fullPage: false
  };

  it('checks health status correctly', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ healthy: true }), { status: 200 })
    );

    const config: SelfHostedBrowserConfig = {
      baseUrl: 'http://agent.local:8080',
      token: 'test-token',
      fetchImpl: mockFetch as any
    };

    const provider = new SelfHostedBrowserProvider(config, mockArtifacts, 'ten_123' as TenantId);
    const healthy = await provider.healthy();

    expect(healthy).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://agent.local:8080/v1/browser/health',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer test-token' })
      })
    );
  });

  it('handles health check failures gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const config: SelfHostedBrowserConfig = {
      baseUrl: 'http://agent.local:8080',
      token: 'test-token',
      fetchImpl: mockFetch as any
    };

    const provider = new SelfHostedBrowserProvider(config, mockArtifacts, 'ten_123' as TenantId);
    const healthy = await provider.healthy();

    expect(healthy).toBe(false);
  });

  it('captures evidence and stores screenshot in artifact store', async () => {
    const base64Pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          screenshotBase64: base64Pixel,
          contentType: 'image/png',
          accessibilityTree: { role: 'WebArea', name: 'Test' },
          width: 1280,
          height: 800
        }),
        { status: 200 }
      )
    );

    const config: SelfHostedBrowserConfig = {
      baseUrl: 'http://agent.local:8080',
      token: 'test-token',
      fetchImpl: mockFetch as any
    };

    const provider = new SelfHostedBrowserProvider(config, mockArtifacts, 'ten_123' as TenantId);
    const evidence = await provider.captureEvidence(sampleInput);

    expect(evidence.screenshot.contentType).toBe('image/png');
    expect(evidence.screenshot.sha256).toBe('mock-sha256');
    expect(evidence.accessibility.tree).toEqual({ role: 'WebArea', name: 'Test' });
  });

  it('executes actions via act()', async () => {
    const base64Pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          screenshotBase64: base64Pixel,
          contentType: 'image/png',
          accessibilityTree: { role: 'WebArea' },
          finalUrl: 'http://localhost:3000/dashboard'
        }),
        { status: 200 }
      )
    );

    const config: SelfHostedBrowserConfig = {
      baseUrl: 'http://agent.local:8080',
      token: 'test-token',
      fetchImpl: mockFetch as any
    };

    const provider = new SelfHostedBrowserProvider(config, mockArtifacts, 'ten_123' as TenantId);
    const result = await provider.act({
      ...sampleInput,
      steps: [{ kind: 'click', selector: '#login-btn' }]
    });

    expect(result.stepsExecuted).toBe(1);
    expect(result.finalUrl).toBe('http://localhost:3000/dashboard');
  });
});
