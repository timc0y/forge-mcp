import type { ToolContext, ToolOutcome, Content } from './tool-types';
import type { Viewport } from './contracts';
import { capture, validateCaptureRequest } from './capture';
import { reserveCaptureQuota } from './quota';
import { ForgeError } from './errors';

export async function captureResult(ctx: ToolContext, url: string, requested: Viewport[] = ['phone', 'desktop']): Promise<ToolOutcome> {
  const viewports = [...new Set(requested.length ? requested : ['phone', 'desktop'] as Viewport[])];
  validateCaptureRequest(url, viewports);
  const enabled = (ctx.env.FORGE_CAPTURE_ALLOWED_LOGINS ?? '').split(',').map((login) => login.trim().toLowerCase()).filter(Boolean);
  if (!enabled.includes(ctx.identity.githubLogin.toLowerCase())) {
    throw new ForgeError({ code: 'FORGE_AUTH_REQUIRED', message: 'Public-page capture is limited to operator-enabled preview accounts while the provider network boundary is verified. No browser request was sent.' });
  }
  const quota = await reserveCaptureQuota(ctx.env, ctx.identity.userId, ctx.identity.githubLogin);
  // A provider request can spend browser time even when its result is rejected
  // locally. Count attempts after validation; never refund uncertain expenditure.
  const shot = await capture(ctx.env, url, viewports);
  ctx.track('capture_taken', { requested: viewports.length, captured: shot.images.length, failures: shot.failures.length });
  const limits = shot.failures.map((entry) => `${entry.viewport}: ${entry.reason}`);
  limits.push('Each capture shows the top of the page, not the full scrollable page. The outline is observation, not an AI diagnosis.');
  if (shot.outlineTruncated) limits.push('The accessibility outline is bounded.');
  const content: Content[] = [];
  if (shot.outline.length) content.push({ type: 'text', text: `Observed page structure:\n${shot.outline.join('\n')}` });
  const shown: string[] = [];
  const responseWarnings: string[] = [];
  let imageBytes = 0;
  for (const image of shot.images) {
    if (imageBytes + image.base64.length > 1_500_000) { limits.push(`${image.viewport} image omitted by the transport byte limit.`); continue; }
    imageBytes += image.base64.length;
    shown.push(image.viewport);
    if (image.httpStatus !== undefined && image.httpStatus >= 400) {
      const kind = image.httpStatus === 403 ? 'denial page' : 'error response';
      const warning = `${image.viewport}: captured an HTTP ${image.httpStatus} ${kind}; the requested page did not load successfully.`;
      limits.push(warning);
      responseWarnings.push(`HTTP ${image.httpStatus} ${kind} at ${image.viewport}`);
    }
    content.push({ type: 'text', text: image.viewport }, { type: 'image', data: image.base64, mimeType: 'image/png' });
  }
  if (!shown.length) throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: 'Capture completed but no image fit the response envelope. The browser cost was incurred; request one viewport rather than treating this as a successful visual review.' });
  return { summary: responseWarnings.length ? `Captured ${responseWarnings.join('; ')}. Review the response limits for each viewport.` : `Captured ${shown.join(' and ')} for the public page.`, structured: { page: { url: shot.url, title: shot.title, shown }, ...(quota.unlimited ? {} : { quota: `${quota.used} of ${quota.limit}` }), limits }, content };
}
