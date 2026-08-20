import { describe, expect, it } from 'vitest';
import type { Capture } from '../src/contracts';
import type { Env } from '../src/env';
import { galleryPage, storeGallery } from '../src/gallery';

interface CaptureRow {
  object_key: string;
  expires_at: string;
}

function fixture(options: { failInsert?: boolean } = {}): {
  env: Env;
  objects: Map<string, string>;
  rows: Map<string, CaptureRow>;
} {
  const objects = new Map<string, string>();
  const rows = new Map<string, CaptureRow>();

  const metadata = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run(): Promise<unknown> {
              if (sql.includes('INSERT INTO captures')) {
                if (options.failInsert) throw new Error('insert failed');
                rows.set(String(args[0]), {
                  object_key: String(args[2]),
                  expires_at: String(args[4])
                });
                return {};
              }
              if (sql.includes('DELETE FROM captures')) {
                rows.delete(String(args[0]));
                return {};
              }
              throw new Error(`Unexpected D1 run: ${sql}`);
            },
            async first<T>(): Promise<T | null> {
              if (!sql.includes('SELECT object_key, expires_at FROM captures')) {
                throw new Error(`Unexpected D1 first: ${sql}`);
              }
              return (rows.get(String(args[0])) as T | undefined) ?? null;
            }
          };
        }
      };
    }
  };

  const artifacts = {
    async put(key: string, value: unknown): Promise<void> {
      if (typeof value !== 'string') throw new Error('Expected a rendered HTML string');
      objects.set(key, value);
    },
    async delete(key: string): Promise<void> {
      objects.delete(key);
    },
    async get(key: string): Promise<unknown> {
      const value = objects.get(key);
      return value === undefined ? null : { body: value };
    }
  };

  return {
    env: {
      METADATA: metadata,
      ARTIFACTS: artifacts,
      FORGE_PUBLIC_ORIGIN: 'https://example.com/forge',
      FORGE_SIGNING_KEY: 'test-signing-key-that-is-at-least-32-bytes'
    } as unknown as Env,
    objects,
    rows
  };
}

function shot(): Capture {
  return {
    url: 'https://example.org/',
    title: 'Example',
    images: [
      {
        viewport: 'desktop',
        base64: btoa('image bytes'),
        bytes: 11
      }
    ],
    outline: ['RootWebArea: Example'],
    outlineTruncated: false,
    failures: []
  };
}

function parts(link: string): { id: string; token: string } {
  const url = new URL(link);
  const id = url.pathname.split('/').filter(Boolean).at(-1);
  const token = url.searchParams.get('t');
  if (!id || !token) throw new Error('Gallery link did not contain an id and token');
  return { id, token };
}

describe('capture gallery lifecycle', () => {
  it('maps a stored capture to its owner and serves it', async () => {
    const { env, objects, rows } = fixture();
    const link = await storeGallery(env, shot(), '2026-08-20T12:00:00.000Z', 'user-1');

    expect(link).not.toBeNull();
    expect(objects.size).toBe(1);
    expect(rows.size).toBe(1);

    const { id, token } = parts(link ?? '');
    const response = await galleryPage(env, id, token);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Example');
  });

  it('refuses and removes an expired tracked capture', async () => {
    const { env, objects, rows } = fixture();
    const link = await storeGallery(env, shot(), '2020-01-01T00:00:00.000Z', 'user-1');
    const { id, token } = parts(link ?? '');

    const response = await galleryPage(env, id, token);
    expect(response.status).toBe(404);
    expect(objects.size).toBe(0);
    expect(rows.size).toBe(0);
  });

  it('removes the object when ownership cannot be recorded', async () => {
    const { env, objects, rows } = fixture({ failInsert: true });
    const link = await storeGallery(env, shot(), '2026-08-20T12:00:00.000Z', 'user-1');

    expect(link).toBeNull();
    expect(objects.size).toBe(0);
    expect(rows.size).toBe(0);
  });
});
