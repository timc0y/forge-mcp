import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { findInSnapshot, scanArchive } from '../src/archive';
import { RequestBudget } from '../src/evidence';
import type { GitHubRequest } from '../src/contracts';

const SHA = 'a'.repeat(40);
const repo = { owner: 'o', name: 'r' };
const encoder = new TextEncoder();

function writeAscii(target: Uint8Array, offset: number, width: number, value: string): void {
  target.set(encoder.encode(value).subarray(0, width), offset);
}
function tarEntry(name: string, content: string): Uint8Array {
  const data = encoder.encode(content);
  const padded = Math.ceil(data.length / 512) * 512;
  const out = new Uint8Array(512 + padded);
  const header = out.subarray(0, 512);
  writeAscii(header, 0, 100, name);
  writeAscii(header, 100, 8, '0000644\0');
  writeAscii(header, 108, 8, '0000000\0');
  writeAscii(header, 116, 8, '0000000\0');
  writeAscii(header, 124, 12, data.length.toString(8).padStart(11, '0') + '\0');
  writeAscii(header, 136, 12, '00000000000\0');
  header.fill(32, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeAscii(header, 257, 6, 'ustar\0');
  writeAscii(header, 263, 2, '00');
  let sum = 0;
  for (const byte of header) sum += byte;
  writeAscii(header, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  out.set(data, 512);
  return out;
}
function archive(entries: Array<[string, string]>): Uint8Array {
  const blocks = [...entries.map(([name, content]) => tarEntry(name, content)), new Uint8Array(1024)];
  const tar = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) { tar.set(block, offset); offset += block.length; }
  return gzipSync(tar);
}
function request(bytes: Uint8Array): GitHubRequest {
  return async () => ({ status: 200, json: null, text: '', headers: new Headers(), stream: new Blob([bytes]).stream() });
}

describe('streaming committed archive', () => {
  it('finds exact text from one immutable archive', async () => {
    const bytes = archive([['root/src/a.ts', 'const needle = 1;\nneedle();\n'], ['root/README.md', 'other\n']]);
    const result = await findInSnapshot(request(bytes), repo, SHA, 'needle', new RequestBudget());
    expect(result.coverage).toBe('complete');
    expect(result.matchedFiles).toBe(1);
    expect(result.hits[0]).toMatchObject({ path: 'src/a.ts', count: 2, lines: [1, 2] });
  });

  it('rejects traversal and duplicate members rather than choosing one', async () => {
    const traversal = archive([['root/../secret', 'x']]);
    await expect(scanArchive(request(traversal), repo, SHA, new RequestBudget(), () => true, () => {})).rejects.toThrow(/unsafe member path/);
    const duplicate = archive([['root/a.ts', 'one'], ['root/a.ts', 'two']]);
    await expect(scanArchive(request(duplicate), repo, SHA, new RequestBudget(), () => true, () => {})).rejects.toThrow(/duplicate member path/);
  });

  it('rejects a corrupted TAR checksum', async () => {
    const bytes = archive([['root/a.ts', 'hello']]);
    const inflated = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    inflated[0] ^= 1;
    const corrupt = gzipSync(inflated);
    await expect(scanArchive(request(corrupt), repo, SHA, new RequestBudget(), () => true, () => {})).rejects.toThrow(/checksum/);
  });
});
