import { describe, expect, it, vi } from 'vitest';
import { parseParts, handleMultipartUpload } from '../../apps/forge-edge-gateway/src/multipart-upload';

// Minimal fake R2 bucket that records the multipart calls the gateway makes, so
// we can assert create -> part -> complete drives the R2 API correctly.
function fakeBucket() {
  const calls: { method: string; args: unknown[] }[] = [];
  const resumed = {
    async uploadPart(partNumber: number, _body: unknown) {
      calls.push({ method: 'uploadPart', args: [partNumber] });
      return { partNumber, etag: `etag-${partNumber}` };
    },
    async complete(parts: unknown[]) {
      calls.push({ method: 'complete', args: [parts] });
      return { size: 12345 };
    }
  };
  const bucket = {
    calls,
    async createMultipartUpload(key: string) {
      calls.push({ method: 'createMultipartUpload', args: [key] });
      return { uploadId: 'up-1' };
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      calls.push({ method: 'resumeMultipartUpload', args: [key, uploadId] });
      return resumed;
    },
    async head(key: string) {
      calls.push({ method: 'head', args: [key] });
      return { size: 999 };
    }
  };
  return bucket as unknown as R2Bucket & { calls: typeof calls };
}

function req(method: string, body?: string): Request {
  return new Request('https://x/__forge_snapshot/ws', body === undefined ? { method } : { method, body });
}

describe('parseParts', () => {
  it('parses N:etag lines, sorts by partNumber, ignores blanks', () => {
    expect(parseParts('2:b\n1:a\n')).toEqual([
      { partNumber: 1, etag: 'a' },
      { partNumber: 2, etag: 'b' }
    ]);
  });

  it('accepts comma-joined entries too', () => {
    expect(parseParts('1:a,2:b')).toEqual([
      { partNumber: 1, etag: 'a' },
      { partNumber: 2, etag: 'b' }
    ]);
  });

  it('drops malformed and non-positive entries', () => {
    expect(parseParts('\n\ngarbage\n0:x\n-1:y\n:z\n3:c\n')).toEqual([{ partNumber: 3, etag: 'c' }]);
  });

  it('returns empty for empty input', () => {
    expect(parseParts('')).toEqual([]);
    expect(parseParts('   \n  ')).toEqual([]);
  });
});

describe('handleMultipartUpload dispatch', () => {
  it('mp=create returns the uploadId as text/plain', async () => {
    const bucket = fakeBucket();
    const url = new URL('https://x/__forge_snapshot/ws?mp=create');
    const res = await handleMultipartUpload('create', bucket, 'key/a', url, req('POST'), async () => {});
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('up-1');
    expect(bucket.calls).toEqual([{ method: 'createMultipartUpload', args: ['key/a'] }]);
  });

  it('mp=part uploads the part and echoes the etag', async () => {
    const bucket = fakeBucket();
    const url = new URL('https://x/__forge_snapshot/ws?mp=part&uploadId=up-1&part=3');
    const res = await handleMultipartUpload('part', bucket, 'key/a', url, req('PUT', 'chunk'), async () => {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('etag-3');
    expect(bucket.calls).toEqual([
      { method: 'resumeMultipartUpload', args: ['key/a', 'up-1'] },
      { method: 'uploadPart', args: [3] }
    ]);
  });

  it('mp=part rejects a non-positive part number', async () => {
    const bucket = fakeBucket();
    const url = new URL('https://x/__forge_snapshot/ws?mp=part&uploadId=up-1&part=0');
    const res = await handleMultipartUpload('part', bucket, 'key/a', url, req('PUT', 'chunk'), async () => {});
    expect(res.status).toBe(400);
    expect(bucket.calls).toEqual([]);
  });

  it('mp=part requires an uploadId', async () => {
    const bucket = fakeBucket();
    const url = new URL('https://x/__forge_snapshot/ws?mp=part&part=1');
    const res = await handleMultipartUpload('part', bucket, 'key/a', url, req('PUT', 'chunk'), async () => {});
    expect(res.status).toBe(400);
  });

  it('mp=complete parses parts, completes, and records via onComplete', async () => {
    const bucket = fakeBucket();
    const onComplete = vi.fn(async () => {});
    const url = new URL('https://x/__forge_snapshot/ws?mp=complete&uploadId=up-1');
    const res = await handleMultipartUpload('complete', bucket, 'key/a', url, req('POST', '2:etag-2\n1:etag-1\n'), onComplete);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, size: 12345 });
    expect(bucket.calls).toEqual([
      { method: 'resumeMultipartUpload', args: ['key/a', 'up-1'] },
      {
        method: 'complete',
        args: [
          [
            { partNumber: 1, etag: 'etag-1' },
            { partNumber: 2, etag: 'etag-2' }
          ]
        ]
      }
    ]);
    expect(onComplete).toHaveBeenCalledWith(12345);
  });

  it('mp=complete rejects an empty parts list', async () => {
    const bucket = fakeBucket();
    const onComplete = vi.fn(async () => {});
    const url = new URL('https://x/__forge_snapshot/ws?mp=complete&uploadId=up-1');
    const res = await handleMultipartUpload('complete', bucket, 'key/a', url, req('POST', '   '), onComplete);
    expect(res.status).toBe(400);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('rejects an unknown mp action', async () => {
    const bucket = fakeBucket();
    const url = new URL('https://x/__forge_snapshot/ws?mp=bogus&uploadId=up-1');
    const res = await handleMultipartUpload('bogus', bucket, 'key/a', url, req('POST'), async () => {});
    expect(res.status).toBe(400);
  });
});
