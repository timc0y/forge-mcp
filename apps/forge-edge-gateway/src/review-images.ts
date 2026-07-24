/**
 * Pure helpers for the screenshot-review path.
 *
 * Kept out of mcp-session.ts (which pulls in `cloudflare:` modules and so cannot
 * be imported by an ordinary test) because the rules here — what a caller is
 * allowed to omit, and which captured images travel back attached to the tool
 * result — are the whole product for the main use case: getting screenshots in
 * front of a model in one call.
 */

// Total base64 budget for images returned inline in one tool result. Screenshots
// ARE the deliverable, so the cap is on bytes rather than a flat count: four
// phone shots cost far less than one full-page desktop capture, and a fixed
// count either starves the cheap case or blows the payload on the expensive one.
// Sized to stay comfortably inside what chat clients accept in one tool result.
export const MAX_INLINE_IMAGE_BYTES = 3_500_000;
export const MAX_INLINE_IMAGES = 8;

// Viewport shorthand. Asking a model to hand-build {id,width,height} objects is a
// pointless failure mode in a non-agentic chat client; 'phone' is not.
const VIEWPORT_PRESETS: Record<string, { id: string; width: number; height: number }> = {
  phone: { id: 'phone', width: 390, height: 844 },
  tablet: { id: 'tablet', width: 820, height: 1180 },
  desktop: { id: 'desktop', width: 1440, height: 900 }
};

export function normalizeViewports(input: unknown): Array<{ id: string; width: number; height: number }> {
  const raw = Array.isArray(input) ? input : [];
  const resolved = raw
    .map((entry) => (typeof entry === 'string' ? VIEWPORT_PRESETS[entry] : entry as { id: string; width: number; height: number }))
    .filter((entry): entry is { id: string; width: number; height: number } => Boolean(entry?.width && entry?.height));
  return resolved.length > 0 ? resolved : [VIEWPORT_PRESETS.phone!, VIEWPORT_PRESETS.desktop!];
}

/**
 * Choose which captured screenshots travel back inside the tool result.
 *
 * Preference order matters: take one image per route first, then widen to the
 * other viewports. A caller who asked for three routes at two viewports and can
 * only be sent four images is far better served by all three routes than by two
 * routes twice over. Stops on either the count or the byte budget, whichever
 * binds first, and reports what it left behind so the caller is never quietly
 * shown a partial picture.
 */
export function selectInlineImages<T extends { route?: unknown; inline?: { base64: string; contentType: string } }>(
  cells: T[]
): { chosen: T[]; omitted: number } {
  const withImages = cells.filter((cell) => cell.inline);
  const seenRoutes = new Set<unknown>();
  const firstPerRoute: T[] = [];
  const rest: T[] = [];
  for (const cell of withImages) {
    if (seenRoutes.has(cell.route)) rest.push(cell);
    else {
      seenRoutes.add(cell.route);
      firstPerRoute.push(cell);
    }
  }
  const chosen: T[] = [];
  let bytes = 0;
  for (const cell of [...firstPerRoute, ...rest]) {
    const size = cell.inline!.base64.length;
    if (chosen.length >= MAX_INLINE_IMAGES || bytes + size > MAX_INLINE_IMAGE_BYTES) continue;
    chosen.push(cell);
    bytes += size;
  }
  return { chosen, omitted: withImages.length - chosen.length };
}
