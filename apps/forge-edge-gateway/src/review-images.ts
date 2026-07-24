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

// ---------------------------------------------------------------------------
// Downscaling for the attached copies.
//
// The stored artifact is always the full-resolution capture — that is the
// evidence. What travels back in a tool result is a smaller copy, because the
// binding constraint on "how many screenshots can the model actually see" is
// payload bytes, and a 1440×900 capture spends that budget several times over
// for detail nobody reads at thumbnail size.
//
// Cost control is the reason this is shaped the way it is. Cloudflare Images
// bills per transformation, so:
//   - images already inside the target are never transformed at all, which is
//     most phone captures and therefore most of the traffic;
//   - only the handful of images that could actually be attached are considered,
//     never the whole grid, so one review costs at most MAX_INLINE_IMAGES
//     transformations however many cells it captured;
//   - and if the binding is absent or errors, the original bytes are used
//     unchanged, so nothing here can turn a working review into a failed one.
// ---------------------------------------------------------------------------

/** Attached copies below this are left alone — transforming them would cost money to save nothing. */
const SHRINK_THRESHOLD_BYTES = 180_000;
/** Wide enough to judge layout and spacing at review size. */
const SHRINK_TARGET_WIDTH = 900;
const SHRINK_QUALITY = 72;

interface ImagesCapableEnv {
  IMAGES?: {
    input: (stream: ReadableStream<Uint8Array>) => {
      transform: (options: { width?: number; fit?: string }) => {
        output: (options: { format: string; quality?: number }) => Promise<{
          image: (options?: { encoding?: 'base64' }) => ReadableStream<Uint8Array>;
          contentType: () => string;
        }>;
      };
    };
  };
}

function base64ToStream(base64: string): ReadableStream<Uint8Array> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes]).stream();
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

/**
 * Order cells so every route is represented before any route repeats — the same
 * preference `selectInlineImages` applies, exposed so the caller can decide which
 * images are worth spending a transformation on before the budget is applied.
 */
export function orderForInline<T extends { route?: unknown }>(cells: T[]): T[] {
  const seen = new Set<unknown>();
  const first: T[] = [];
  const rest: T[] = [];
  for (const cell of cells) {
    if (seen.has(cell.route)) rest.push(cell);
    else {
      seen.add(cell.route);
      first.push(cell);
    }
  }
  return [...first, ...rest];
}

/**
 * Shrink the copies that are plausibly going to be attached, then apply the byte
 * budget. Returns the same shape as selectInlineImages.
 */
export async function prepareInlineImages<
  T extends { route?: unknown; inline?: { base64: string; contentType: string } }
>(env: unknown, cells: T[]): Promise<{ chosen: T[]; omitted: number }> {
  const images = (env as ImagesCapableEnv | undefined)?.IMAGES;
  if (!images) return selectInlineImages(cells);

  const ordered = orderForInline(cells.filter((cell) => cell.inline));
  const shrunk: T[] = [];
  // Only the images that could actually be attached are candidates for a
  // transformation; everything past the cap is going to be omitted anyway.
  for (const [index, cell] of ordered.entries()) {
    if (index >= MAX_INLINE_IMAGES || cell.inline!.base64.length <= SHRINK_THRESHOLD_BYTES) {
      shrunk.push(cell);
      continue;
    }
    try {
      const result = await images
        .input(base64ToStream(cell.inline!.base64))
        .transform({ width: SHRINK_TARGET_WIDTH, fit: 'scale-down' })
        .output({ format: 'image/jpeg', quality: SHRINK_QUALITY });
      const base64 = (await streamToText(result.image({ encoding: 'base64' }))).trim();
      // A transform that came back bigger is not worth having.
      shrunk.push(base64 && base64.length < cell.inline!.base64.length
        ? { ...cell, inline: { base64, contentType: result.contentType() || 'image/jpeg' } }
        : cell);
    } catch {
      // Images unavailable, unsupported input, quota — the original is fine.
      shrunk.push(cell);
    }
  }
  const selected = selectInlineImages(shrunk);
  // `omitted` must account for every captured image, including any this function
  // never considered.
  return { chosen: selected.chosen, omitted: cells.filter((cell) => cell.inline).length - selected.chosen.length };
}
