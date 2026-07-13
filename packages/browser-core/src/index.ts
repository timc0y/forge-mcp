import type { ArtifactId, WorkspaceId } from '@forge/core';
export interface ScreenshotInput { workspaceId: WorkspaceId; url: string; path: string; headers?: Record<string,string>; viewport: { width: number; height: number }; fullPage: boolean; operationId: string; repositoryCommit?: string; workspaceRevision: number; }
export interface ScreenshotResult { artifactId: ArtifactId; contentType: 'image/png'; width: number; height: number; sha256: string; }
export interface AccessibilityResult { tree: unknown; truncated: boolean; }
export interface BrowserEvidenceResult { screenshot: ScreenshotResult; accessibility: AccessibilityResult; }
export interface BrowserProvider { screenshot(input: ScreenshotInput): Promise<ScreenshotResult>; accessibilityTree(input: Omit<ScreenshotInput,'fullPage'>): Promise<AccessibilityResult>; captureEvidence(input: ScreenshotInput): Promise<BrowserEvidenceResult>; }
