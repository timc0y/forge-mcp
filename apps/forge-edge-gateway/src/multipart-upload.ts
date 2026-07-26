// Chunked multipart upload for the capability-gated snapshot/deps R2 gateway.
// Large (hundreds of MB) tars exceed the Cloudflare Worker inbound request-body
// limit (~100MB) when streamed in one shot, so the container splits the tar and
// uploads each part as its own sub-100MB request via `?mp=create|part|complete`.
// These helpers are pure (no Worker-only imports) so they can be unit-tested in
// isolation; the endpoints in index.ts verify the capability before calling in.

// Parse the parts list a container POSTs to `?mp=complete`. Accepts one
// `N:etag` entry per line and/or comma-separated; blanks and malformed entries
// are dropped. Returns entries sorted by partNumber, in the shape R2's
// `complete()` expects.
export function parseParts(text: string): { partNumber: number; etag: string }[] {
  return text
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx <= 0) return null;
      const partNumber = Number(entry.slice(0, idx));
      const etag = entry.slice(idx + 1).trim();
      if (!Number.isInteger(partNumber) || partNumber < 1 || !etag) return null;
      return { partNumber, etag };
    })
    .filter((p): p is { partNumber: number; etag: string } => p !== null)
    .sort((a, b) => a.partNumber - b.partNumber);
}

// Run one multipart action against the R2 binding. The caller has ALREADY
// verified the capability and derived `key` — this only drives the R2 API and
// records D1 (via onComplete) on the final step.
export async function handleMultipartUpload(
  action: string,
  bucket: R2Bucket,
  key: string,
  url: URL,
  request: Request,
  onComplete: (sizeBytes: number) => Promise<void>
): Promise<Response> {
  const textPlain = { 'content-type': 'text/plain' };
  if (action === 'create') {
    const mp = await bucket.createMultipartUpload(key);
    return new Response(mp.uploadId, { status: 200, headers: textPlain });
  }
  const uploadId = url.searchParams.get('uploadId') ?? '';
  if (!uploadId) return new Response('Missing uploadId', { status: 400 });
  if (action === 'part') {
    const partNumber = Number(url.searchParams.get('part'));
    if (!Number.isInteger(partNumber) || partNumber < 1) return new Response('Bad part number', { status: 400 });
    if (!request.body) return new Response('Missing body', { status: 400 });
    const mp = bucket.resumeMultipartUpload(key, uploadId);
    const p = await mp.uploadPart(partNumber, request.body);
    return new Response(p.etag, { status: 200, headers: textPlain });
  }
  if (action === 'complete') {
    const parts = parseParts(await request.text());
    if (parts.length === 0) return new Response('No parts', { status: 400 });
    const mp = bucket.resumeMultipartUpload(key, uploadId);
    const object = await mp.complete(parts);
    let size = object?.size ?? 0;
    if (!size) size = (await bucket.head(key))?.size ?? 0;
    await onComplete(size);
    return Response.json({ ok: true, size });
  }
  return new Response('Bad mp action', { status: 400 });
}
