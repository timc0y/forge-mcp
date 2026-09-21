import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Snapshot } from '../src/snapshot';
import { upstreamEvidence } from '../src/upstream';
import type { GitHubRequest } from '../src/contracts';

const PRIVATE_SHA = 'a'.repeat(40);
const PUBLIC_SHA = 'b'.repeat(40);
const BLOB = 'c'.repeat(40);
const encoder = new TextEncoder();

function writeAscii(target: Uint8Array, offset: number, width: number, value: string): void {
  target.set(encoder.encode(value).subarray(0, width), offset);
}
function tarEntry(name: string, content: string): Uint8Array {
  const data = encoder.encode(content);
  const out = new Uint8Array(512 + Math.ceil(data.length / 512) * 512);
  const header = out.subarray(0, 512);
  writeAscii(header, 0, 100, name);
  writeAscii(header, 100, 8, '0000644\0');
  writeAscii(header, 108, 8, '0000000\0');
  writeAscii(header, 116, 8, '0000000\0');
  writeAscii(header, 124, 12, data.length.toString(8).padStart(11, '0') + '\0');
  writeAscii(header, 136, 12, '00000000000\0');
  header.fill(32, 148, 156);
  header[156] = 48;
  writeAscii(header, 257, 6, 'ustar\0');
  writeAscii(header, 263, 2, '00');
  let sum = 0;
  for (const byte of header) sum += byte;
  writeAscii(header, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  out.set(data, 512);
  return out;
}
function archive(files: Record<string, string>): Uint8Array {
  const blocks = [...Object.entries(files).map(([path, content]) => tarEntry('root/' + path, content)), new Uint8Array(1024)];
  const bytes = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) { bytes.set(block, offset); offset += block.length; }
  return gzipSync(bytes);
}

function privateGitHub(options: { truncated?: boolean; additionalManifests?: number; lock?: string } = {}) {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ devDependencies: { typescript: '^5.9.0' } }),
    'pnpm-lock.yaml': options.lock ?? "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      typescript:\n        specifier: ^5.9.0\n        version: 5.9.3\n",
    'src/index.ts': "import ts from 'typescript';\nexport const version = ts.version;\n"
  };
  for (let index = 0; index < (options.additionalManifests ?? 0); index++) files[`packages/p${index}/package.json`] = JSON.stringify({ name: `p${index}` });
  const zipped = archive(files);
  const tree = Object.entries(files).map(([path, content]) => ({ path, type: 'blob', size: encoder.encode(content).length }));
  const request: GitHubRequest = async (path) => {
    if (path === '/repos/private/app') return { status: 200, json: { default_branch: 'main', private: true }, text: '', headers: new Headers() };
    if (path === '/repos/private/app/commits/main') return { status: 200, json: { sha: PRIVATE_SHA }, text: '', headers: new Headers() };
    if (path.startsWith('/repos/private/app/git/trees/')) return { status: 200, json: { truncated: options.truncated ?? false, tree }, text: '', headers: new Headers() };
    if (path.startsWith('/repos/private/app/tarball/')) return { status: 200, json: null, text: '', headers: new Headers(), stream: new Blob([zipped]).stream() };
    const match = /^\/repos\/private\/app\/contents\/(.+)\?ref=/.exec(path);
    if (match) {
      const value = files[decodeURIComponent(match[1]!)];
      if (value !== undefined) return { status: 200, json: { type: 'file', encoding: 'base64', content: btoa(value), sha: BLOB, size: encoder.encode(value).length }, text: '', headers: new Headers() };
    }
    return { status: 404, json: null, text: '', headers: new Headers() };
  };
  return request;
}

function publicGitHub(tagExists: boolean) {
  const calls: string[] = [];
  const request: GitHubRequest = async (path) => {
    calls.push(path);
    if (path === '/repos/microsoft/TypeScript/git/ref/tags/v5.9.3') {
      return { status: tagExists ? 200 : 404, json: tagExists ? { ref: 'refs/tags/v5.9.3', object: { sha: PUBLIC_SHA } } : null, text: '', headers: new Headers() };
    }
    if (path === '/repos/microsoft/TypeScript') return { status: 200, json: { default_branch: 'main', private: false }, text: '', headers: new Headers() };
    if (path === '/repos/microsoft/TypeScript/commits/refs%2Ftags%2Fv5.9.3') return { status: 200, json: { sha: PUBLIC_SHA }, text: '', headers: new Headers() };
    if (path === `/repos/microsoft/TypeScript/git/trees/${PUBLIC_SHA}?recursive=1` || path === `/repos/microsoft/TypeScript/git/trees/${PUBLIC_SHA}`) {
      return { status: 200, json: { truncated: false, tree: [{ path: 'README.md', type: 'blob', size: 10 }, { path: 'package.json', type: 'blob', size: 10 }] }, text: '', headers: new Headers() };
    }
    return { status: 404, json: null, text: '', headers: new Headers() };
  };
  return { request, calls };
}

describe('version-pinned public upstream evidence', () => {
  it('joins a private declared range to the exact installed lock version and reviewed tag', async () => {
    const snapshot = await Snapshot.open(privateGitHub(), { owner: 'private', name: 'app' });
    const publicGh = publicGitHub(true);
    const result = await upstreamEvidence(snapshot, publicGh.request, 'typescript') as any;
    expect(result.version).toBe('5.9.3');
    expect(result.installed[0]).toMatchObject({ manifest: 'package.json', lockfile: 'pnpm-lock.yaml', importer: '.', version: '5.9.3' });
    expect(result.upstream.tag).toBe('v5.9.3');
    expect(result.upstream.source.sha).toBe(PUBLIC_SHA);
    expect(result.uses[0]).toMatchObject({ path: 'src/index.ts', specifier: 'typescript' });
    expect(publicGh.calls.some((path) => path.includes('/commits/main'))).toBe(false);
  });

  it('does not substitute upstream HEAD when the reviewed version tag is absent', async () => {
    const snapshot = await Snapshot.open(privateGitHub(), { owner: 'private', name: 'app' });
    const publicGh = publicGitHub(false);
    await expect(upstreamEvidence(snapshot, publicGh.request, 'typescript')).rejects.toThrow(/HEAD was not substituted/);
    expect(publicGh.calls.some((path) => path.includes('/commits/main'))).toBe(false);
  });

  it('makes no public request when the private repository tree is truncated', async () => {
    const snapshot = await Snapshot.open(privateGitHub({ truncated: true }), { owner: 'private', name: 'app' });
    const publicGh = publicGitHub(true);
    await expect(upstreamEvidence(snapshot, publicGh.request, 'typescript')).rejects.toThrow(/incomplete repository tree/);
    expect(publicGh.calls).toEqual([]);
  });

  it('makes no public request when package-manifest coverage exceeds its bound', async () => {
    const snapshot = await Snapshot.open(privateGitHub({ additionalManifests: 12 }), { owner: 'private', name: 'app' });
    const publicGh = publicGitHub(true);
    await expect(upstreamEvidence(snapshot, publicGh.request, 'typescript')).rejects.toThrow(/bounded to 12 package manifests/);
    expect(publicGh.calls).toEqual([]);
  });

  it('turns excessive YAML alias expansion into a typed source validation failure', async () => {
    const aliases = Array.from({ length: 101 }, () => '  - *shared').join('\n');
    const lock = "lockfileVersion: '9.0'\nshared: &shared { value: repeated }\naliases:\n" + aliases + "\nimporters:\n  .:\n    devDependencies:\n      typescript:\n        specifier: ^5.9.0\n        version: 5.9.3\n";
    const snapshot = await Snapshot.open(privateGitHub({ lock }), { owner: 'private', name: 'app' });
    const publicGh = publicGitHub(true);
    await expect(upstreamEvidence(snapshot, publicGh.request, 'typescript')).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
    expect(publicGh.calls).toEqual([]);
  });
});
