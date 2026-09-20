import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { configurationHashForSnapshot, readAnalysisZip } from '../src/analysis-artifact';
import { Snapshot } from '../src/snapshot';
import type { GitHubRequest } from '../src/contracts';

const encoder = new TextEncoder();
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(name: string, text: string): Uint8Array {
  const file = encoder.encode(name);
  const data = encoder.encode(text);
  const localLength = 30 + file.length + data.length;
  const centralLength = 46 + file.length;
  const out = new Uint8Array(localLength + centralLength + 22);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  const crc = crc32(data);
  view.setUint32(14, crc, true);
  view.setUint32(18, data.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, file.length, true);
  view.setUint16(28, 0, true);
  out.set(file, 30);
  out.set(data, 30 + file.length);

  const central = localLength;
  view.setUint32(central, 0x02014b50, true);
  view.setUint16(central + 4, 0x0314, true);
  view.setUint16(central + 6, 20, true);
  view.setUint16(central + 8, 0, true);
  view.setUint16(central + 10, 0, true);
  view.setUint32(central + 16, crc, true);
  view.setUint32(central + 20, data.length, true);
  view.setUint32(central + 24, data.length, true);
  view.setUint16(central + 28, file.length, true);
  view.setUint16(central + 30, 0, true);
  view.setUint16(central + 32, 0, true);
  view.setUint16(central + 34, 0, true);
  view.setUint32(central + 38, 0o100644 << 16, true);
  view.setUint32(central + 42, 0, true);
  out.set(file, central + 46);

  const end = central + centralLength;
  view.setUint32(end, 0x06054b50, true);
  view.setUint16(end + 4, 0, true);
  view.setUint16(end + 6, 0, true);
  view.setUint16(end + 8, 1, true);
  view.setUint16(end + 10, 1, true);
  view.setUint32(end + 12, centralLength, true);
  view.setUint32(end + 16, central, true);
  view.setUint16(end + 20, 0, true);
  return out;
}

describe('analysis artifact ZIP envelope', () => {
  it('accepts exactly one bounded forge-analysis.json member', () => {
    const text = '{"schemaVersion":1}';
    expect(readAnalysisZip(zip('forge-analysis.json', text))).toBe(text);
  });
  it('rejects alternate member names', () => {
    expect(() => readAnalysisZip(zip('../forge-analysis.json', '{}'))).toThrow(/only permitted member/);
  });
  it('rejects content whose CRC no longer matches the directory', () => {
    const bytes = zip('forge-analysis.json', '{"ok":true}');
    bytes[30 + 'forge-analysis.json'.length] ^= 1;
    expect(() => readAnalysisZip(bytes)).toThrow(/checksum/);
  });

  it('hashes committed analysis configuration identically to the producer algorithm', async () => {
    const sha = 'a'.repeat(40);
    const blob = 'b'.repeat(40);
    const files: Record<string, string> = { 'a.txt': 'alpha\n', 'nested/b.txt': 'βeta\n' };
    const gh: GitHubRequest = async (path) => {
      if (path === '/repos/o/r') return { status: 200, json: { default_branch: 'main', private: false }, text: '', headers: new Headers() };
      if (path === '/repos/o/r/commits/main') return { status: 200, json: { sha }, text: '', headers: new Headers() };
      const match = /^\/repos\/o\/r\/contents\/(.+)\?ref=/.exec(path);
      if (match) {
        const value = files[decodeURIComponent(match[1]!)];
        if (value !== undefined) return { status: 200, json: { type: 'file', encoding: 'base64', content: btoa(unescape(encodeURIComponent(value))), sha: blob, size: new TextEncoder().encode(value).length }, text: '', headers: new Headers() };
      }
      return { status: 404, json: null, text: '', headers: new Headers() };
    };
    const snapshot = await Snapshot.open(gh, { owner: 'o', name: 'r' });
    const expected = createHash('sha256');
    for (const path of ['a.txt', 'nested/b.txt']) {
      expected.update(path); expected.update('\0'); expected.update(files[path]!); expected.update('\0');
    }
    expect(await configurationHashForSnapshot(snapshot, ['nested/b.txt', 'a.txt'])).toBe(expected.digest('hex'));
  });
});
