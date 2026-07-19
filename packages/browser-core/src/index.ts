import type { ArtifactId, WorkspaceId } from '@forge/core';
export type { StructureFinding, StructureFindingKind, StructureHealth } from './structure-health';
export { analyzeStructureHealth } from './structure-health';
import type { StructureHealth } from './structure-health';
export type ImageContentType = 'image/png' | 'image/jpeg';
// `format`/`quality` pick the screenshot codec: JPEG is far smaller than PNG
// for UI evidence (less R2 storage, less Worker CPU to base64, fewer client
// tokens) at a resolution that still supports visual review; PNG stays
// available for pixel-exact needs. `deadlineAt` (epoch ms) lets a batched
// caller cap the provider's internal retry budget so a slow cell cannot eat a
// shared capture deadline.
export interface ScreenshotInput { workspaceId: WorkspaceId; url: string; path: string; headers?: Record<string,string>; viewport: { width: number; height: number }; fullPage: boolean; operationId: string; repositoryCommit?: string; workspaceRevision: number; format?: ImageContentType; quality?: number; cacheTtlSeconds?: number; deadlineAt?: number; }
// `inline` carries the freshly captured image so callers can return it without
// a second R2 round trip. `base64` is exactly what Browser Run returned (no
// decode/re-encode needed for the inline path).
export interface ScreenshotResult { artifactId: ArtifactId; contentType: ImageContentType; width: number; height: number; sha256: string; sizeBytes: number; inline?: { base64: string; contentType: ImageContentType }; }
// `structure` is the derived heading-defect signal for `tree`, computed once by
// the provider so every evidence path (review, capture, act, tree) carries it.
export interface AccessibilityResult { tree: unknown; truncated: boolean; structure: StructureHealth; }
export interface BrowserEvidenceResult { screenshot: ScreenshotResult; accessibility: AccessibilityResult; }
// Bounded interactive primitives so multi-step journeys (add to cart, submit a
// form, open a menu) can be exercised before capturing evidence, rather than
// only proving a single rendered state.
export type BrowserActionStep =
  | { kind: 'navigate'; path: string }
  | { kind: 'click'; selector: string }
  | { kind: 'fill'; selector: string; value: string }
  | { kind: 'press'; key: string }
  | { kind: 'wait_for_selector'; selector: string; timeoutMs?: number }
  | { kind: 'wait_for_text'; text: string; timeoutMs?: number }
  | { kind: 'wait'; timeoutMs: number }
  | { kind: 'reload' };
export interface BrowserActInput extends ScreenshotInput { steps: BrowserActionStep[]; }
export interface BrowserActResult extends BrowserEvidenceResult { stepsExecuted: number; finalUrl?: string; }
export interface BrowserProvider { screenshot(input: ScreenshotInput): Promise<ScreenshotResult>; accessibilityTree(input: Omit<ScreenshotInput,'fullPage'>): Promise<AccessibilityResult>; captureEvidence(input: ScreenshotInput): Promise<BrowserEvidenceResult>; act(input: BrowserActInput): Promise<BrowserActResult>; }
