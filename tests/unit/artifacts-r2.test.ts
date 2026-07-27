import { describe, expect, it } from 'vitest';
import { R2ArtifactStore } from '../../packages/artifacts-r2/src/index';

function fakeBucket(): R2Bucket {
  const store = new Map<string, { body: ArrayBuffer; contentType: string; metadata: Record<string, string> }>();
  return {
    async put(key: string, body: ArrayBuffer | ReadableStream, options?: R2PutOptions & { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }) {
      const bytes = body instanceof ArrayBuffer ? body : new Uint8Array(await new Response(body as ReadableStream).arrayBuffer()).buffer;
      store.set(key, {
        body: bytes,
        contentType: options?.httpMetadata?.contentType ?? 'application/octet-stream',
        metadata: options?.customMetadata ?? {}
      });
    },
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        key,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(entry.body));
            controller.close();
          }
        }),
        bodyUsed: false,
        arrayBuffer: async () => entry.body,
        text: async () => new TextDecoder().decode(entry.body),
        json: async <T>() => JSON.parse(new TextDecoder().decode(entry.body)) as T,
        blob: async () => new Blob([entry.body]),
        httpMetadata: { contentType: entry.contentType },
        customMetadata: entry.metadata,
        size: entry.body.byteLength,
        writeHttpMetadata: () => {},
        truncated: false,
        uploadDetails: {} as R2UploadedDetails,
        version: '1',
      } as unknown as R2Object;
    },
    async list(options?: R2ListOptions) {
      const prefix = options?.prefix ?? '';
      const objects = [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, entry]) => ({
          key,
          size: entry.body.byteLength,
          version: '1',
          uploadDetails: {} as R2UploadedDetails,
          httpMetadata: { contentType: entry.contentType },
          customMetadata: entry.metadata
        }));
      return { objects, truncated: false, delimitedPrefixes: [] };
    },
    async delete(keys: string | string[]) {
      const k = Array.isArray(keys) ? keys : [keys];
      for (const key of k) store.delete(key);
    },
    async head() { return null; },
    createMultipartUpload: async () => ({ uploadId: '' }),
    resumeMultipartUpload: () => ({} as R2MultipartUpload),
  } as R2Bucket;
}

describe('R2ArtifactStore.put', () => {
  it('stores bytes and returns a correct artifact ref', async () => {
    const bucket = fakeBucket();
    const store = new R2ArtifactStore(bucket);
    const bytes = new TextEncoder().encode('hello world').buffer;
    const ref = await store.put({
      id: 'art_abc123' as never,
      tenantId: 'ten_test' as never,
      workspaceId: 'ws_test' as never,
      kind: 'upload',
      contentType: 'text/plain',
      bytes,
      metadata: { author: 'test' }
    });
    expect(ref.id).toBe('art_abc123');
    expect(ref.key).toContain('tenant/ten_test/workspace/ws_test/artifacts/art_abc123');
    expect(ref.contentType).toBe('text/plain');
    expect(ref.sizeBytes).toBe(11);
    expect(ref.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('computes the correct SHA-256', async () => {
    const bucket = fakeBucket();
    const store = new R2ArtifactStore(bucket);
    const bytes = new TextEncoder().encode('test data').buffer;
    const ref = await store.put({
      id: 'art_sha' as never,
      tenantId: 'ten_t' as never,
      workspaceId: 'ws_w' as never,
      kind: 'upload',
      contentType: 'application/octet-stream',
      bytes,
      metadata: {}
    });
    const expectedHash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (b) => b.toString(16).padStart(2, '0')
    ).join('');
    expect(ref.sha256).toBe(expectedHash);
  });

  it('writes the correct content type and metadata to the bucket', async () => {
    const bucket = fakeBucket();
    const store = new R2ArtifactStore(bucket);
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    await store.put({
      id: 'art_meta' as never,
      tenantId: 'ten_m' as never,
      workspaceId: 'ws_m' as never,
      kind: 'upload',
      contentType: 'image/png',
      bytes,
      metadata: { step: 'build', version: '2' }
    });
    const obj = await bucket.get('tenant/ten_m/workspace/ws_m/artifacts/art_meta');
    expect(obj).not.toBeNull();
    expect(obj?.httpMetadata?.contentType).toBe('image/png');
    expect(obj?.customMetadata).toEqual({ step: 'build', version: '2' });
  });

  it('handles empty bytes', async () => {
    const bucket = fakeBucket();
    const store = new R2ArtifactStore(bucket);
    const ref = await store.put({
      id: 'art_empty' as never,
      tenantId: 'ten_e' as never,
      workspaceId: 'ws_e' as never,
      kind: 'upload',
      contentType: 'application/octet-stream',
      bytes: new ArrayBuffer(0),
      metadata: {}
    });
    expect(ref.sizeBytes).toBe(0);
    expect(ref.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects undefined metadata values without crashing', async () => {
    const bucket = fakeBucket();
    const store = new R2ArtifactStore(bucket);
    const ref = await store.put({
      id: 'art_undef' as never,
      tenantId: 'ten_u' as never,
      workspaceId: 'ws_u' as never,
      kind: 'upload',
      contentType: 'text/plain',
      bytes: new Uint8Array([0]).buffer,
      metadata: { defined: 'yes', undefined: undefined }
    });
    const obj = await bucket.get(ref.key);
    expect(obj?.customMetadata).toEqual({ defined: 'yes' });
  });
});

describe('R2ArtifactStore.get', () => {
  it('returns null for a missing artifact', async () => {
    const bucket = fakeBucket();
    const store = new R2ArtifactStore(bucket);
    const response = await store.get('ten_test' as never, 'ws_test' as never, 'art_nonexistent' as never);
    expect(response).toBeNull();
  });

  it('returns a Response with the stored content', async () => {
    const bucket = fakeBucket();
    const store = new R2ArtifactStore(bucket);
    const bytes = new TextEncoder().encode('stored content').buffer;
    await store.put({
      id: 'art_gettest' as never,
      tenantId: 'ten_g' as never,
      workspaceId: 'ws_g' as never,
      kind: 'upload',
      contentType: 'application/json',
      bytes,
      metadata: {}
    });
    const response = await store.get('ten_g' as never, 'ws_g' as never, 'art_gettest' as never);
    expect(response).not.toBeNull();
    expect(response!.headers.get('content-type')).toBe('application/json');
    expect(await response!.text()).toBe('stored content');
  });
});

describe('R2ArtifactStore.deleteWorkspace', () => {
  it('deletes all artifacts for a workspace', async () => {
    const bucket = fakeBucket();
    const store = new R2ArtifactStore(bucket);
    for (let i = 0; i < 3; i++) {
      await store.put({
        id: `art_del${i}` as never,
        tenantId: 'ten_d' as never,
        workspaceId: 'ws_d' as never,
        kind: 'upload',
        contentType: 'text/plain',
        bytes: new Uint8Array([i]).buffer,
        metadata: {}
      });
    }
    await store.put({
      id: 'art_other' as never,
      tenantId: 'ten_d' as never,
      workspaceId: 'ws_other' as never,
      kind: 'upload',
      contentType: 'text/plain',
      bytes: new Uint8Array([9]).buffer,
      metadata: {}
    });
    await store.deleteWorkspace('ten_d' as never, 'ws_d' as never);
    const listing = await bucket.list({ prefix: 'tenant/ten_d/workspace/ws_d/' });
    expect(listing.objects).toHaveLength(0);
    const other = await bucket.get('tenant/ten_d/workspace/ws_other/artifacts/art_other');
    expect(other).not.toBeNull();
  });

  it('succeeds when no artifacts exist for the workspace', async () => {
    const bucket = fakeBucket();
    const store = new R2ArtifactStore(bucket);
    await expect(store.deleteWorkspace('ten_empty' as never, 'ws_empty' as never)).resolves.toBeUndefined();
  });
});
