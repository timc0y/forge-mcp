import { describe, expect, it } from 'vitest';
import { readAnalysisZip } from '../src/analysis-artifact';

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
});
