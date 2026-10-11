import type { ToolContext, ToolOutcome, Content } from './tool-types';
import type { Viewport } from './contracts';
import { capture } from './capture';
import { reserveCaptureQuota, releaseCaptureQuota } from './quota';
import { ForgeError } from './errors';

export async function captureResult(ctx: ToolContext, url: string, requested: Viewport[] = ['phone', 'desktop']): Promise<ToolOutcome> {
  const viewports = [...new Set(requested.length ? requested : ['phone', 'desktop'] as Viewport[])];
  const quota = await reserveCaptureQuota(ctx.env, ctx.identity.userId, ctx.identity.githubLogin);
  let shot: Awaited<ReturnType<typeof capture>>;
  try { shot = await capture(ctx.env, url, viewports); }
  catch (error) {
    if (!quota.unlimited && quota.day) await releaseCaptureQuota(ctx.env, ctx.identity.userId, quota.day).catch(() => console.error('forge_capture_quota_release_failed'));
    throw error;
  }
  ctx.track('capture_taken', { requested: viewports.length, captured: shot.images.length, failures: shot.failures.length });
  const limits = shot.failures.map((entry) => `${entry.viewport}: ${entry.reason}`);
  limits.push('Each capture shows the top of the page, not the full scrollable page. The outline is observation, not an AI diagnosis.');
  if (shot.outlineTruncated) limits.push('The accessibility outline is bounded.');
  const content: Content[] = [];
  if (shot.outline.length) content.push({ type: 'text', text: `Observed page structure:\n${shot.outline.join('\n')}` });
  const shown: string[] = [];
  let imageBytes = 0;
  for (const image of shot.images) {
    if (imageBytes + image.base64.length > 1_500_000) { limits.push(`${image.viewport} image omitted by the transport byte limit.`); continue; }
    imageBytes += image.base64.length;
    shown.push(image.viewport);
    content.push({ type: 'text', text: image.viewport }, { type: 'image', data: image.base64, mimeType: 'image/png' });
  }
  if (!shown.length) throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: 'Capture completed but no image fit the response envelope. The browser cost was incurred; request one viewport rather than treating this as a successful visual review.' });
  return { summary: `Captured ${shown.join(' and ')} for the public page.`, structured: { page: { url: shot.url, title: shot.title, shown }, ...(quota.unlimited ? {} : { quota: `${quota.used} of ${quota.limit}` }), limits }, content };
}
