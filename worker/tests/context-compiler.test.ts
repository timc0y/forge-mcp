import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Snapshot } from '../src/snapshot';
import { compileContext } from '../src/context-compiler';
import type { GitHubRequest } from '../src/contracts';
import type { Env } from '../src/env';

const SHA = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;

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
function tar(files: Record<string, string>): Uint8Array {
  const blocks = [...Object.entries(files).map(([path, content]) => tarEntry('root/' + path, content)), new Uint8Array(1024)];
  const bytes = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) { bytes.set(block, offset); offset += block.length; }
  return gzipSync(bytes);
}
function distribution(keys: string[], winner: string): Record<string, number> {
  if (keys.length === 1) return { [keys[0]!]: 1 };
  const rest = 0.1 / (keys.length - 1);
  return Object.fromEntries(keys.map((key) => [key, key === winner ? 0.9 : rest]));
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe('task-shaped context compilation', () => {
  it('finds relevant generic files from structure and can expand to a reverse-importing test', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 100; index++) files['src/filler-' + String(index).padStart(3, '0') + '.ts'] = 'export function noop' + index + '() { return ' + index + '; }\n';
    files['src/core.ts'] = 'export function submitInvoiceDelivery(reference: string) {\n  if (!reference) throw new Error("invoice delivery reference required");\n  return reference;\n}\n';
    files['src/api.ts'] = 'import { submitInvoiceDelivery } from "./core";\nexport const post = (id: string) => submitInvoiceDelivery(id);\n';
    files['tests/core.test.ts'] = 'import { submitInvoiceDelivery } from "../src/core";\nit("rejects duplicate invoice delivery", () => expect(() => submitInvoiceDelivery("")).toThrow());\n';
    const archive = tar(files);
    const tree = Object.entries(files).map(([path, content]) => ({ path, type: 'blob', size: encoder.encode(content).length }));
    const gh: GitHubRequest = async (path, init) => {
      if (path === '/repos/o/r') return { status: 200, json: { default_branch: 'main', private: false }, text: '', headers: new Headers() };
      if (path === '/repos/o/r/commits/main') return { status: 200, json: { sha: SHA }, text: '', headers: new Headers() };
      if (path.startsWith('/repos/o/r/git/trees/')) return { status: 200, json: { truncated: false, tree }, text: '', headers: new Headers() };
      if (path.startsWith('/repos/o/r/tarball/')) return { status: 200, json: null, text: '', headers: new Headers(), stream: new Blob([archive]).stream() };
      const match = /^\/repos\/o\/r\/contents\/(.+)\?ref=/.exec(path);
      if (match) {
        const file = files[decodeURIComponent(match[1]!)];
        if (file !== undefined) return { status: 200, json: { type: 'file', encoding: 'base64', content: btoa(file), sha: BLOB, size: encoder.encode(file).length }, text: '', headers: new Headers() };
      }
      return { status: 404, json: null, text: '', headers: new Headers() };
    };

    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body ?? '{}'));
      const state = request.input.state as Record<string, any>;
      const questions = request.input.questions as Record<string, any>;
      const answers: Record<string, unknown> = {};
      if (state.candidates?.[0]?.symbols !== undefined) {
        for (const [id] of Object.entries(questions)) {
          const index = Number(id.split('_')[1]);
          answers[id] = { type: 'noul', noul: state.candidates[index]?.path === 'src/core.ts' ? 0.99 : 0.05 };
        }
      } else if (questions.gap) {
        const targets = Object.keys(questions.target.criteria);
        answers.gap = { type: 'choice', choice: 'test', confidence: 0.9, probabilities: distribution(Object.keys(questions.gap.criteria), 'test') };
        answers.target = { type: 'choice', choice: 'tests/core.test.ts', confidence: 0.9, probabilities: distribution(targets, 'tests/core.test.ts') };
      } else {
        for (const [id, question] of Object.entries(questions) as Array<[string, any]>) {
          if (id.startsWith('relevant_')) answers[id] = { type: 'noul', noul: 0.95 };
          else if (id.startsWith('counter_')) answers[id] = { type: 'noul', noul: 0.2 };
          else answers[id] = { type: 'choice', choice: 'body', confidence: 0.9, probabilities: { body: 0.9, outline: 0.1 } };
        }
      }
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const snapshot = await Snapshot.open(gh, { owner: 'o', name: 'r' });
    const env = {
      TYPESAFE_API_KEY: 'key',
      TYPESAFE_BASE_URL: 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/ai/run'
    } as Env;
    const packet = await compileContext(snapshot, env, 'why can duplicate invoice delivery fail?') as any;
    expect(packet.evidence.some((item: any) => item.selector === 'src/core.ts::symbol:submitInvoiceDelivery')).toBe(true);
    expect(packet.evidence.some((item: any) => item.path === 'tests/core.test.ts')).toBe(true);
    expect(packet.relationships.some((edge: any) => edge.from === 'tests/core.test.ts' && edge.to === 'src/core.ts')).toBe(true);
    expect(packet.limitations.join(' ')).toContain('structurally summarized candidates');
  });
});
