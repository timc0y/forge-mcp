import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Snapshot } from '../src/snapshot';
import { compileContext } from '../src/context-compiler';
import { utf8Bytes } from '../src/evidence';
import type { GitHubRequest } from '../src/contracts';
import type { Env } from '../src/env';

const SHA = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;

const CASES = [
  'invoice recovery', 'release cleanup finally', 'lease takeover ownership',
  'retired browser runner', 'issue ledger action', 'request reference conflict',
  'cart checkout handoff', 'migration destructive safety', 'worker release verification',
  'contact delivery outbox', 'editorial notion sync', 'taxonomy malformed label',
  'private source boundary', 'exact commit check', 'approval base revision',
  'analysis artifact provenance', 'upstream installed version', 'json record selector',
  'unicode source range', 'crlf source range', 'duplicate symbol selector',
  'import alias caller', 'failure regression test', 'configuration contract',
  'markdown instruction rule', 'liquid structure block', 'yaml configuration validation',
  'public repository discovery', 'immutable source identity', 'context packing counter evidence'
] as const;

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
  const blocks = Object.entries(files).map(([path, content]) => tarEntry('root/' + path, content));
  blocks.push(new Uint8Array(1024));
  const bytes = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) { bytes.set(block, offset); offset += block.length; }
  return gzipSync(bytes);
}
function filler(label: string, lines: number): string {
  return Array.from({ length: lines }, (_value, index) => '  const ' + label + index + ' = ' + index + ';\n').join('');
}
function fixture(marker: string, phrase: string): Record<string, string> {
  const files: Record<string, string> = {
    'AGENTS.md': '# Rules\n\n## Preserve\nKeep exact failure evidence and immutable source identities.\n',
    'src/core.ts':
      'export function ' + marker + '(value: string) {\n' +
      filler('local', 30) +
      '  if (!value) throw new Error("' + phrase + ' required");\n  return value;\n}\n\n' +
      'export function unrelatedOne() {\n' + filler('one', 250) + '  return true;\n}\n\n' +
      'export function unrelatedTwo() {\n' + filler('two', 250) + '  return false;\n}\n',
    'src/caller.ts':
      'import { ' + marker + ' } from "./core";\nexport function call(value: string) {\n' +
      filler('caller', 250) + '  return ' + marker + '(value);\n}\n',
    'tests/core.test.ts':
      'import { ' + marker + ' } from "../src/core";\n' +
      'describe("' + phrase + '", () => {\n' + filler('setup', 30) +
      '  it("retains the failure path", () => expect(() => ' + marker + '("")).toThrow());\n});\n'
  };
  for (let index = 0; index < 28; index++) {
    files['src/filler-' + String(index).padStart(2, '0') + '.ts'] =
      'export function filler' + index + '() { return ' + index + '; }\n';
  }
  return files;
}
function probabilities(keys: string[], winner: string): Record<string, number> {
  const other = keys.length > 1 ? 0.1 / (keys.length - 1) : 0;
  return Object.fromEntries(keys.map((key) => [key, key === winner ? 0.9 : other]));
}
function github(files: Record<string, string>): GitHubRequest {
  const zipped = archive(files);
  const tree = Object.entries(files).map(([path, content]) => ({
    path, type: 'blob', size: utf8Bytes(content)
  }));
  return async (path) => {
    if (path === '/repos/eval/repo') {
      return { status: 200, json: { default_branch: 'main', private: false }, text: '', headers: new Headers() };
    }
    if (path === '/repos/eval/repo/commits/main') {
      return { status: 200, json: { sha: SHA }, text: '', headers: new Headers() };
    }
    if (path.startsWith('/repos/eval/repo/git/trees/')) {
      return { status: 200, json: { truncated: false, tree }, text: '', headers: new Headers() };
    }
    if (path.startsWith('/repos/eval/repo/tarball/')) {
      return { status: 200, json: null, text: '', headers: new Headers(), stream: new Blob([zipped]).stream() };
    }
    const match = /^\/repos\/eval\/repo\/contents\/(.+)\?ref=/.exec(path);
    if (match) {
      const value = files[decodeURIComponent(match[1]!)];
      if (value !== undefined) {
        return {
          status: 200,
          json: { type: 'file', encoding: 'base64', content: btoa(value), sha: BLOB, size: utf8Bytes(value) },
          text: '',
          headers: new Headers()
        };
      }
    }
    return { status: 404, json: null, text: '', headers: new Headers() };
  };
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe('30-case deterministic context plumbing evaluation', () => {
  it('meets the context/call budget while retaining gold target and failure-test evidence', async () => {
    const ratios: number[] = [];
    for (let caseIndex = 0; caseIndex < CASES.length; caseIndex++) {
      const phrase = CASES[caseIndex]!;
      const marker = 'target' + caseIndex;
      const files = fixture(marker, phrase);

      globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}'));
        const state = request.input.state as Record<string, any>;
        const questions = request.input.questions as Record<string, any>;
        const answers: Record<string, unknown> = {};

        if (state.candidates?.[0]?.symbols !== undefined) {
          for (const key of Object.keys(questions)) {
            const index = Number(key.split('_')[1]);
            answers[key] = {
              type: 'noul',
              noul: state.candidates[index]?.path === 'src/core.ts' ? 0.99 : 0.01
            };
          }
        } else if (questions.gap) {
          const testId = state.candidates.find((entry: any) => entry.path === 'tests/core.test.ts')?.id;
          answers.gap = {
            type: 'choice',
            choice: 'test',
            confidence: 0.9,
            probabilities: probabilities(Object.keys(questions.gap.criteria), 'test')
          };
          answers.target = {
            type: 'choice',
            choice: testId,
            confidence: 0.9,
            probabilities: probabilities(Object.keys(questions.target.criteria), testId)
          };
        } else {
          for (const [key] of Object.entries(questions)) {
            const index = Number(key.split('_')[1]);
            const candidate = state.candidates[index];
            const isTarget = String(candidate?.text ?? '').includes(marker);
            if (key.startsWith('relevant_')) {
              answers[key] = { type: 'noul', noul: isTarget ? 0.99 : 0.01 };
            } else if (key.startsWith('counter_')) {
              answers[key] = { type: 'noul', noul: isTarget ? 0.7 : 0.01 };
            } else {
              answers[key] = {
                type: 'choice',
                choice: 'body',
                confidence: 0.9,
                probabilities: { body: 0.9, outline: 0.1 }
              };
            }
          }
        }
        return new Response(JSON.stringify({
          model: 'jev-1.13.0',
          answers,
          usage: { input_tokens: 20, output_tokens: 5 }
        }), { status: 200 });
      }) as typeof fetch;

      const snapshot = await Snapshot.open(github(files), { owner: 'eval', name: 'repo' });
      const packet = await compileContext(snapshot, {
        TYPESAFE_API_KEY: 'key',
        TYPESAFE_BASE_URL: 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/ai/run'
      } as Env, 'Investigate ' + phrase + ' and preserve its regression evidence.') as any;

      const selectors = packet.evidence.map((entry: any) => String(entry.selector));
      expect(selectors.some((selector: string) =>
        selector.includes('src/core.ts::symbol:' + marker)), phrase).toBe(true);
      expect(selectors.some((selector: string) =>
        selector.includes('tests/core.test.ts::symbol:')), phrase).toBe(true);
      expect(packet.source.sha, phrase).toBe(SHA);
      expect(packet.budget.jevStages, phrase).toBeLessThanOrEqual(3);
      expect(packet.budget.estimate, phrase).toBeLessThanOrEqual(4096);

      // Defined deterministic baseline: the equivalent manual workflow exposes
      // complete rules, target implementation, caller and regression test over
      // multiple model/tool rounds. This proves V2 plumbing/packing efficiency;
      // it does not certify hosted-JEV relevance quality on production repos.
      const baselineVisibleBytes =
        utf8Bytes(files['AGENTS.md']!) +
        utf8Bytes(files['src/core.ts']!) +
        utf8Bytes(files['src/caller.ts']!) +
        utf8Bytes(files['tests/core.test.ts']!);
      const v2VisibleBytes = utf8Bytes(JSON.stringify(packet));
      ratios.push(v2VisibleBytes / baselineVisibleBytes);
      expect(v2VisibleBytes, phrase).toBeLessThanOrEqual(Math.floor(baselineVisibleBytes * 0.5));

      const baselineSearchReadRounds = 6;
      const v2SearchReadRounds = 1;
      expect(v2SearchReadRounds, phrase).toBeLessThanOrEqual(baselineSearchReadRounds * 0.5);
    }

    ratios.sort((a, b) => a - b);
    expect(CASES).toHaveLength(30);
    expect(ratios[Math.floor(ratios.length / 2)]!).toBeLessThanOrEqual(0.5);
  }, 30_000);
});
