import { gzipSync } from 'node:zlib';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseSelector, selectSource } from '../src/selectors';
import { inspectStructure } from '../src/structure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Snapshot } from '../src/snapshot';
import { compileContext } from '../src/context-compiler';
import { utf8Bytes } from '../src/evidence';
import type { GitHubRequest } from '../src/contracts';
import { semanticEnv } from './helpers/semantic-db';

const SHA = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
function parserAnchors(path: string, text: string) {
  return inspectStructure(path, text).blocks.map((block) => ({ selector: `${path}::symbol:${block.name}`, range: block.range }));
}
function sourceReceipt(selector: string, text: string) {
  return { selector, ...selectSource(parseSelector(selector), text), coverage: 'complete' };
}

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
      return { status: 200, json: null, text: '', headers: new Headers(), stream: new Blob([new Uint8Array(zipped)]).stream() };
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
  it('keeps a direct implementation visible when repeated caller blocks dominate lexical matches', async () => {
    const files: Record<string, string> = {
      'AGENTS.md': 'Preserve immutable source and complete constraints.\n',
      'src/owner.ts': 'export function configure() { return ["read", "edit", "see", "merge", "discard"]; }\n',
    };
    for (let index = 0; index < 11; index++) {
      files[`src/caller-${index}.ts`] = Array.from({ length: 8 }, (_, block) =>
        `export function mention${block}() { return "five tools registered five tools registered"; }\n`).join('');
    }
    let ownerWasOffered = false;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const { input } = JSON.parse(String(init?.body));
      const { state, questions } = input;
      const answers: Record<string, unknown> = {};
      if (state.candidates[0]?.symbols !== undefined) {
        for (const key of Object.keys(questions)) answers[key] = { type: 'noul', noul: state.candidates[Number(key.split('_')[1])]?.path === 'AGENTS.md' ? 0.01 : 0.9 };
      } else if (questions.gap) {
        for (const key of ['gap', 'target']) answers[key] = { type: 'choice', choice: 'none', confidence: 0.9, probabilities: probabilities(Object.keys(questions[key].criteria), 'none') };
      } else {
        ownerWasOffered = state.candidates.some((entry: any) => entry.path === 'src/owner.ts');
        for (const key of Object.keys(questions)) {
          const candidate = state.candidates[Number(key.split('_')[1])];
          if (key.startsWith('primary_')) answers[key] = { type: 'noul', noul: candidate?.path === 'src/owner.ts' ? 0.99 : 0.01 };
          else if (key.startsWith('counter_')) answers[key] = { type: 'noul', noul: 0.01 };
          else if (key.startsWith('relevant_')) answers[key] = { type: 'noul', noul: 0.9 };
          else answers[key] = { type: 'choice', choice: 'body', confidence: 0.9, probabilities: { body: 0.9, outline: 0.1 } };
        }
      }
      return Response.json({ success: true, errors: [], messages: [], result: { state: 'Completed', result: { model: 'jev-1.13.0', answers } } });
    }) as typeof fetch;
    const packet = await compileContext(await Snapshot.open(github(files), { owner: 'eval', name: 'repo' }), semanticEnv(), 'Where are the five tools registered?') as any;
    expect(ownerWasOffered).toBe(true);
    expect(packet.status).toBe('bounded');
    expect(packet.evidence).toContainEqual(expect.objectContaining({ selector: 'src/owner.ts::symbol:configure', mandatory: true, text: files['src/owner.ts']!.trim() }));
  });

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
            if (key.startsWith('primary_')) {
              answers[key] = { type: 'noul', noul: state.candidates[index]?.path === 'src/core.ts' && isTarget ? 0.99 : 0.01 };
            } else if (key.startsWith('relevant_')) {
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
        return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { state: 'Completed', result: {
          model: 'jev-1.13.0',
          answers,
          usage: { input_tokens: 20, output_tokens: 5 }
        } } }), { status: 200 });
      }) as typeof fetch;

      const snapshot = await Snapshot.open(github(files), { owner: 'eval', name: 'repo' });
      const packet = await compileContext(snapshot, semanticEnv(), 'Investigate ' + phrase + ' and preserve its regression evidence.') as any;

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
    }

    ratios.sort((a, b) => a - b);
    expect(CASES).toHaveLength(30);
    expect(ratios[Math.floor(ratios.length / 2)]!).toBeLessThanOrEqual(0.5);
  }, 30_000);
});

describe('opt-in real-question evaluator', () => {
  it('grounds every dataset selector and source assertion in the local Forge source', async () => {
    const { validateDataset } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const dataset = validateDataset(JSON.parse(readFileSync(new URL('../scripts/context-questions.json', import.meta.url), 'utf8')));
    for (const question of dataset) for (const expected of [...question.required, ...question.counterevidence]) {
      const selector = parseSelector(expected.selector);
      const source = readFileSync(new URL('../../' + selector.path, import.meta.url), 'utf8');
      const selected = selectSource(selector, source);
      for (const text of expected.mustContain) expect(selected.text, expected.selector).toContain(text);
    }
  });

  it('records initial recall, counterevidence, returned-selector reads, cumulative usage, calls and measured latency', async () => {
    const { evaluateQuestions, judgeQuestion } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const dataset = JSON.parse(readFileSync(new URL('../scripts/context-questions.json', import.meta.url), 'utf8'));
    const question = dataset[0];
    const guard = sourceReceipt(question.required[0].selector, readFileSync(new URL('../src/write.ts', import.meta.url), 'utf8'));
    const regression = sourceReceipt(question.required[1].selector, readFileSync(new URL('../../' + parseSelector(question.required[1].selector).path, import.meta.url), 'utf8'));
    const packet = { status: 'insufficient', source: { repo: question.repo, sha: SHA }, evidence: [guard], required: [{ selector: guard.selector, delivered: true }, { selector: regression.selector, delivered: false }], unverified: [`Required source not delivered: ${regression.selector}`, 'The identified test gap remains unverified.'], gap: { category: 'test', selector: regression.selector, addressed: false }, omitted: [{ selector: regression.selector, stage: 'packing' }], inference: [{ usage: { inputTokens: 40, outputTokens: 10 }, accounting: 'settled' }, { usage: { inputTokens: 30, outputTokens: 10 }, accounting: 'unknown' }, { usage: { inputTokens: 30, outputTokens: 5 }, accounting: 'settled' }], budget: { githubCalls: 7, jevStages: 3 } };
    const calls: any[] = [];
    const report = await evaluateQuestions([question], async (input: any) => {
      calls.push(input);
      return { structuredContent: input.paths ? { source: packet.source, files: [regression] } : { context: packet } };
    }, { at: SHA, followUps: 1 });
    expect(report.rows[0].initial).toMatchObject({ requiredEvidenceRecall: 0.5, missing: [regression.selector], missingCounterevidence: [], taskCompletion: { judgment: 'insufficient' } });
    expect(report.rows[0].afterReturnedSelectorReads).toMatchObject({ requiredEvidenceRecall: 1, compilerUnverified: [], remainingDelivery: [], recoveredSelectors: [regression.selector], taskCompletion: { judgment: 'evidence-complete' } });
    expect(packet.status).toBe('insufficient');
    expect(packet.required[1]!.delivered).toBe(false);
    expect(report.totals).toMatchObject({ forgeReadCalls: 2, semanticStagesKnown: 3, githubCallsKnown: 7, githubUnreportedReads: 1, usage: { inputTokens: 100, outputTokens: 25, accountingSettledStages: 2, accountingUnknownStages: 1 } });
    expect(report.rows[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.rows[0].followUpSelectors).toEqual([regression.selector]);
    expect(calls[1]).toEqual({ repo: question.repo, at: SHA, paths: [regression.selector] });
    expect((await judgeQuestion(question, { ...packet, evidence: [guard, { ...regression, text: 'it("conflict", () => expect(true).toBe(true));' }] })).requiredEvidenceRecall).toBe(0.5);
  });

  it.each(['semantic gap', 'failed stage', 'unread instruction'])('preserves a real %s after source recovery', async (failure) => {
    const { evaluateQuestions } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const question = { id: 'recovery', repo: 'o/r', question: 'Show guard', required: [{ selector: 'a.ts::symbol:guard', mustContain: ['throw new Error("conflict")'] }], counterevidence: [] };
    const source = { repo: 'o/r', sha: SHA };
    const selector = question.required[0]!.selector;
    const reason = failure === 'semantic gap' ? 'The identified incomplete gap remains unverified.' : failure === 'failed stage' ? 'JEV evidence stage failed.' : 'Required source not delivered: AGENTS.md';
    const packet = { source, status: 'insufficient', evidence: [], required: [{ selector, delivered: false }, ...(failure === 'unread instruction' ? [{ selector: 'AGENTS.md', delivered: false }] : [])], unverified: [`Required source not delivered: ${selector}`, reason], omitted: [{ selector }], gap: { category: failure === 'semantic gap' ? 'incomplete' : 'none', selector: null, addressed: false } };
    const report = await evaluateQuestions([question], async (input: any) => ({ structuredContent: input.paths ? { source, files: [sourceReceipt(selector, 'function guard() { throw new Error("conflict"); }')] } : { context: packet } }), { at: SHA, followUps: 1 });
    expect(report.rows[0].afterReturnedSelectorReads).toMatchObject({ requiredEvidenceRecall: 1, compilerUnverified: [reason], taskCompletion: { judgment: 'insufficient' } });
  });

  it.each([1, 2])('keeps instructions unverified until an exact read covers every physical line (read end: %i)', async (end) => {
    const { evaluateQuestions } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const question = { id: 'instructions', repo: 'o/r', question: 'Show guard', required: [{ selector: 'a.ts::symbol:guard', mustContain: ['return false'] }], counterevidence: [] };
    const source = { repo: 'o/r', sha: SHA };
    const packet = { source, status: 'insufficient', evidence: [sourceReceipt(question.required[0]!.selector, 'function guard() { return false; }')], required: [{ selector: 'AGENTS.md', delivered: false }], unverified: ['Required source not delivered: AGENTS.md'], omitted: [{ selector: 'AGENTS.md', followUp: `AGENTS.md:1-${end}` }] };
    const selector = `AGENTS.md:1-${end}`;
    const selected = selectSource(parseSelector(selector), 'Preserve guards.\nPreserve tests.\n');
    const report = await evaluateQuestions([question], async (input: any) => ({ structuredContent: input.paths ? { source, files: [{ selector, ...selected }] } : { context: packet } }), { at: SHA, followUps: 1 });
    expect(report.rows[0].afterReturnedSelectorReads.taskCompletion.judgment).toBe(end === 2 ? 'evidence-complete' : 'insufficient');
    expect(report.rows[0].afterReturnedSelectorReads.remainingDelivery).toEqual(end === 2 ? [] : ['AGENTS.md']);
  });

  it('recovers a complete parser block from a proven exact line range within a larger file', async () => {
    const { evaluateQuestions } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const question = { id: 'lines', repo: 'o/r', question: 'Show guard', required: [{ selector: 'a.ts::symbol:guard', mustContain: ['throw new Error("conflict")'] }], counterevidence: [] };
    const source = { repo: 'o/r', sha: SHA };
    const text = '// preface\nfunction guard() { throw new Error("conflict"); }\n// tail\n';
    const packet = { source, status: 'insufficient', evidence: [], selectionAnchors: parserAnchors('a.ts', text), required: [{ selector: question.required[0]!.selector, delivered: false }], unverified: [`Required source not delivered: ${question.required[0]!.selector}`], omitted: [{ selector: question.required[0]!.selector, followUp: 'a.ts:2-2' }] };
    const selected = selectSource(parseSelector('a.ts:2-2'), text);
    const report = await evaluateQuestions([question], async (input: any) => ({ structuredContent: input.paths ? { source, files: [{ selector: 'a.ts:2-2', ...selected }] } : { context: packet } }), { at: SHA, followUps: 1 });
    expect(report.rows[0].afterReturnedSelectorReads.taskCompletion.judgment).toBe('evidence-complete');
  });

  it.each([
    { path: 'a.ts', name: 'Guard/check', source: 'class Guard {\n  check() { throw new Error("conflict"); }\n}\n', assertion: 'throw new Error("conflict")' },
    { path: 'a.test.ts', name: 'it:rejects[1]', source: 'it("rejects", () => expect(true).toBe(true));\nit("rejects", () => expect(save()).rejects.toThrow("conflict"));\n', assertion: 'expect(save()).rejects.toThrow("conflict")' },
    { path: 'rules.md', name: 'Rules/Guard', source: '# Rules\nKeep literal source.\n## Guard\nPreserve the conflict path.\n', assertion: 'Preserve the conflict path.' }
  ])('grades the original complete parser receipt for $name in context and exact recovery', async ({ path, name, source: text, assertion }) => {
    const { evaluateQuestions } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const selector = `${path}::symbol:${name}`;
    const selected = selectSource(parseSelector(selector), text);
    const provenance = inspectStructure(path, text).parser;
    const source = { repo: 'o/r', sha: SHA };
    const question = { id: 'receipt', repo: 'o/r', question: 'Show the exact guard', required: [{ selector, mustContain: [assertion] }], counterevidence: [] };
    const receipt = { selector, ...selected };
    for (const recover of [false, true]) {
      const packet = { source, status: recover ? 'insufficient' : 'bounded', evidence: recover ? [] : [{ ...receipt, source, provenance, coverage: 'complete' }], required: [{ selector, delivered: !recover }], unverified: recover ? [`Required source not delivered: ${selector}`] : [], omitted: recover ? [{ selector }] : [] };
      const report = await evaluateQuestions([question], async (input: any) => ({ structuredContent: input.paths ? { source, files: [{ ...receipt, blob: BLOB }] } : { context: packet } }), { at: SHA, followUps: 1 });
      expect(report.rows[0].initial.requiredEvidenceRecall).toBe(recover ? 0 : 1);
      expect(report.rows[0].afterReturnedSelectorReads).toMatchObject({ requiredEvidenceRecall: 1, remainingDelivery: [], taskCompletion: { judgment: 'evidence-complete' } });
    }
  });

  it.each(['parent symbol', 'line range'])('does not renumber indexed children inside a %s receipt', async (kind) => {
    const { evaluateQuestions, judgeQuestion } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const path = 'tests/indexed.test.ts';
    const text = [
      'it("rejects", () => expect(false).toBe(false));',
      'describe("group", () => {',
      '  it("rejects", () => expect(true).toBe(true));',
      '  it("rejects", () => expect(save()).rejects.toThrow("conflict"));',
      '});'
    ].join('\n');
    const source = { repo: 'o/r', sha: SHA };
    const falseSelector = `${path}::symbol:it:rejects[1]`;
    const trueSelector = `${path}::symbol:it:rejects[2]`;
    const assertion = 'expect(save()).rejects.toThrow("conflict")';
    expect(selectSource(parseSelector(falseSelector), text).text).toContain('expect(true).toBe(true)');
    expect(selectSource(parseSelector(trueSelector), text).text).toContain(assertion);
    const parentSelector = `${path}::symbol:describe:group`;
    const parent = selectSource(parseSelector(parentSelector), text);
    const selector = kind === 'parent symbol' ? parentSelector : `${path}:${parent.range.startLine}-${parent.range.endLine}`;
    const fragment = { selector, ...selectSource(parseSelector(selector), text), source, provenance: inspectStructure(path, text).parser, coverage: 'complete' };
    expect(selectSource(parseSelector(falseSelector), fragment.text).text).toContain(assertion);
    const wrongQuestion = { id: 'wrong-index', repo: 'o/r', question: 'Prove the conflict regression', required: [{ selector: falseSelector, mustContain: [assertion] }], counterevidence: [] };
    const wrong = await judgeQuestion(wrongQuestion, { source, status: 'bounded', evidence: [fragment], required: [{ selector: falseSelector, delivered: true }] });
    expect(wrong).toMatchObject({ requiredEvidenceRecall: 0, missing: [falseSelector], taskCompletion: { judgment: 'insufficient' } });
    const question = { ...wrongQuestion, id: 'indexed-recovery', required: [{ selector: trueSelector, mustContain: [assertion] }] };
    const anchored = { source, status: 'bounded', evidence: [fragment], selectionAnchors: parserAnchors(path, text) };
    expect((await judgeQuestion(wrongQuestion, anchored)).requiredEvidenceRecall).toBe(0);
    expect((await judgeQuestion(question, anchored)).requiredEvidenceRecall).toBe(1);
    for (const recoverySelector of [trueSelector, path, `${path}:1-5`]) {
      const packet = { source, status: 'insufficient', evidence: [fragment], required: [{ selector: trueSelector, delivered: false }], unverified: [`Required source not delivered: ${trueSelector}`], omitted: [{ selector: trueSelector, followUp: recoverySelector }] };
      const receipt = { selector: recoverySelector, ...selectSource(parseSelector(recoverySelector), text), blob: BLOB };
      const report = await evaluateQuestions([question], async (input: any) => ({ structuredContent: input.paths ? { source, files: [receipt] } : { context: packet } }), { at: SHA, followUps: 1 });
      expect(report.rows[0].initial).toMatchObject({ requiredEvidenceRecall: 0, taskCompletion: { judgment: 'insufficient' } });
      expect(report.rows[0].afterReturnedSelectorReads, recoverySelector).toMatchObject({ requiredEvidenceRecall: 1, remainingDelivery: [], taskCompletion: { judgment: 'evidence-complete' } });
      const stillWrong = await judgeQuestion(wrongQuestion, { source, status: 'bounded', evidence: [{ ...receipt, source, coverage: 'complete' }] });
      expect(stillWrong.requiredEvidenceRecall, recoverySelector).toBe(0);
    }
  });

  it.each(['parent symbol', 'line range'])('rejects a globally ambiguous name that becomes unique inside a %s', async (kind) => {
    const { judgeQuestion, evaluateQuestions } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const path = 'tests/ambiguous.test.ts';
    const text = 'it("rejects", () => expect(true).toBe(true));\ndescribe("group", () => {\n  it("rejects", () => expect(save()).rejects.toThrow("conflict"));\n});';
    const selector = `${path}::symbol:it:rejects`;
    expect(() => selectSource(parseSelector(selector), text)).toThrow(/indexed name/);
    const parent = sourceReceipt(`${path}::symbol:describe:group`, text);
    const fragment = kind === 'parent symbol' ? parent : sourceReceipt(`${path}:${parent.range.startLine}-${parent.range.endLine}`, text);
    expect(selectSource(parseSelector(selector), fragment.text).text).toContain('expect(save()).rejects.toThrow("conflict")');
    const source = { repo: 'o/r', sha: SHA };
    const question = { id: 'ambiguous', repo: 'o/r', question: 'Show the regression', required: [{ selector, mustContain: ['expect(save()).rejects.toThrow("conflict")'] }], counterevidence: [] };
    const selectionAnchors = parserAnchors(path, text);
    expect(selectionAnchors.some((anchor) => anchor.selector === selector)).toBe(false);
    const packet = { source, status: 'bounded', evidence: [fragment], selectionAnchors, required: [{ selector, delivered: true }] };
    expect(await judgeQuestion(question, packet)).toMatchObject({ requiredEvidenceRecall: 0, remainingDelivery: [selector], taskCompletion: { judgment: 'insufficient' } });
    const originalSelector = `${selector}[1]`;
    const recoverable = { ...question, required: [{ selector: originalSelector, mustContain: question.required[0]!.mustContain }] };
    for (const followUp of [originalSelector, path]) {
      const initial = { ...packet, selectionAnchors: [], status: 'insufficient', required: [{ selector: originalSelector, delivered: false }], unverified: [`Required source not delivered: ${originalSelector}`], omitted: [{ selector: originalSelector, followUp }] };
      const report = await evaluateQuestions([recoverable], async (input: any) => ({ structuredContent: input.paths ? { source, files: [{ ...sourceReceipt(followUp, text), blob: BLOB }] } : { context: initial } }), { at: SHA, followUps: 1 });
      expect(report.rows[0].initial.requiredEvidenceRecall).toBe(0);
      expect(report.rows[0].afterReturnedSelectorReads.taskCompletion.judgment).toBe('evidence-complete');
    }
  });

  it.each(['parent symbol', 'line range'])('requires an original anchor for a unique child inside a %s', async (kind) => {
    const { judgeQuestion } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const path = 'tests/unique.test.ts';
    const text = '// preface\ndescribe("group", () => {\n  it("rejects conflict", () => expect(save()).rejects.toThrow("conflict"));\n});\n// tail';
    const selector = `${path}::symbol:it:rejects conflict`;
    const parent = sourceReceipt(`${path}::symbol:describe:group`, text);
    const fragment = kind === 'parent symbol' ? parent : sourceReceipt(`${path}:${parent.range.startLine}-${parent.range.endLine}`, text);
    const question = { repo: 'o/r', required: [{ selector, mustContain: ['expect(save()).rejects.toThrow("conflict")'] }], counterevidence: [] };
    const packet = { source: { repo: 'o/r', sha: SHA }, status: 'bounded', evidence: [fragment], required: [{ selector, delivered: true }] };
    expect((await judgeQuestion(question, packet)).taskCompletion.judgment).toBe('insufficient');
    const anchors = parserAnchors(path, text);
    expect(await judgeQuestion(question, { ...packet, selectionAnchors: anchors, selectionAnchorCoverage: { total: anchors.length + 1, listed: anchors.length, complete: false } })).toMatchObject({ requiredEvidenceRecall: 1, taskCompletion: { judgment: 'evidence-complete' } });
  });

  it.each(['outside body', 'fractional offset', 'wrong line', 'wrong path', 'duplicate anchor', 'incomplete body'])('refuses an invalid anchor receipt: %s', async (kind) => {
    const { judgeQuestion } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const path = 'tests/anchors.test.ts';
    const text = '// preface\ndescribe("group", () => {\n  it("rejects conflict", () => expect(save()).rejects.toThrow("conflict"));\n});';
    const selector = `${path}::symbol:it:rejects conflict`;
    const original = parserAnchors(path, text).find((anchor) => anchor.selector === selector)!;
    const anchor = { ...original, range: { ...original.range } };
    if (kind === 'outside body') anchor.range.start = 0;
    if (kind === 'fractional offset') anchor.range.end -= 0.5;
    if (kind === 'wrong line') anchor.range.startLine++;
    if (kind === 'wrong path') anchor.selector = 'tests/other.test.ts::symbol:it:rejects conflict';
    const parent = sourceReceipt(`${path}::symbol:describe:group`, text);
    const result = await judgeQuestion({ repo: 'o/r', required: [{ selector, mustContain: ['expect(save()).rejects.toThrow("conflict")'] }], counterevidence: [] }, { source: { repo: 'o/r', sha: SHA }, status: 'bounded', evidence: [{ ...parent, ...(kind === 'incomplete body' ? { text: parent.text.slice(0, -1) } : {}) }], selectionAnchors: kind === 'duplicate anchor' ? [anchor, anchor] : [anchor] });
    expect(result.requiredEvidenceRecall).toBe(0);
  });

  it('does not treat a plain-path body with a fragment range as a whole-file receipt', async () => {
    const { judgeQuestion } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const text = 'it("rejects", () => expect(true).toBe(true));\nit("rejects", () => expect(save()).rejects.toThrow("conflict"));';
    const path = 'tests/plain.test.ts';
    const fragment = { ...sourceReceipt(`${path}:2-2`, text), selector: path };
    const result = await judgeQuestion({ repo: 'o/r', required: [{ selector: `${path}::symbol:it:rejects`, mustContain: ['expect(save()).rejects.toThrow("conflict")'] }], counterevidence: [] }, { source: { repo: 'o/r', sha: SHA }, status: 'bounded', evidence: [fragment] });
    expect(result.requiredEvidenceRecall).toBe(0);
  });

  it('does not credit a symbol fragment as a complete physical line, then recovers through the exact line selector', async () => {
    const { evaluateQuestions } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const text = 'function guard() { return false; } function other() { return true; }';
    const selector = 'a.ts:1-1';
    const fragment = { selector: 'a.ts::symbol:guard', ...selectSource(parseSelector('a.ts::symbol:guard'), text), coverage: 'complete', provenance: inspectStructure('a.ts', text).parser };
    const source = { repo: 'o/r', sha: SHA };
    const question = { id: 'physical-line', repo: 'o/r', question: 'Show the whole guard line', required: [{ selector, mustContain: ['return false'] }], counterevidence: [] };
    const packet = { source, status: 'insufficient', evidence: [fragment], required: [{ selector, delivered: false }], unverified: [`Required source not delivered: ${selector}`], omitted: [{ selector }] };
    const report = await evaluateQuestions([question], async (input: any) => ({ structuredContent: input.paths ? { source, files: [{ selector, ...selectSource(parseSelector(selector), text), blob: BLOB }] } : { context: packet } }), { at: SHA, followUps: 1 });
    expect(report.rows[0].initial).toMatchObject({ requiredEvidenceRecall: 0, remainingDelivery: [selector], taskCompletion: { judgment: 'insufficient' } });
    expect(report.rows[0].afterReturnedSelectorReads).toMatchObject({ requiredEvidenceRecall: 1, remainingDelivery: [], taskCompletion: { judgment: 'evidence-complete' } });
  });

  it('proves the real conflict regression inside a complete containing describe block', async () => {
    const { judgeQuestion } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const question = JSON.parse(readFileSync(new URL('../scripts/context-questions.json', import.meta.url), 'utf8'))[0];
    const path = parseSelector(question.required[1].selector).path;
    const source = readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
    const selector = `${path}::symbol:describe:write deadline before the durable ref update`;
    const parent = sourceReceipt(selector, source);
    const result = await judgeQuestion({ ...question, required: [question.required[1]], counterevidence: [] }, { status: 'bounded', source: { repo: question.repo, sha: SHA }, evidence: [parent], selectionAnchors: parserAnchors(path, source), unverified: [] });
    expect(result).toMatchObject({ requiredEvidenceRecall: 1, taskCompletion: { judgment: 'evidence-complete' } });
  });

  it.each(['comment', 'unrelated assertions', 'duplicate names', 'commented assertions'])('refuses %s as proof of child source containment', async (kind) => {
    const { judgeQuestion } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const criterion = { selector: 'tests/a.test.ts::symbol:it:rejects conflict', mustContain: ['expect(save()).rejects.toThrow("conflict")'] };
    const real = 'it("rejects conflict", () => expect(save()).rejects.toThrow("conflict"));';
    const other = 'it("unrelated", () => expect(save()).rejects.toThrow("conflict"));';
    const body = kind === 'comment' ? `/*${real}*/ ${other}` : kind === 'unrelated assertions' ? `it("rejects conflict", () => expect(true).toBe(true)); ${other}` : kind === 'duplicate names' ? `${real} ${real}` : `it("rejects conflict", () => { /* expect(save()).rejects.toThrow("conflict") */ expect(true).toBe(true); });`;
    const text = `describe("group", () => { ${body} });`;
    const parent = sourceReceipt('tests/a.test.ts::symbol:describe:group', text);
    const result = await judgeQuestion({ repo: 'o/r', required: [criterion], counterevidence: [] }, { status: 'bounded', source: { repo: 'o/r', sha: SHA }, evidence: [parent], selectionAnchors: parserAnchors('tests/a.test.ts', text) });
    expect(result).toMatchObject({ requiredEvidenceRecall: 0, taskCompletion: { judgment: 'insufficient' } });
  });

  it.each(['exact symbol', 'containing parent', 'whole file', 'scoped method', 'uppercase source'])('uses parser comment boundaries after a regex in a %s receipt', async (kind) => {
    const { judgeQuestion } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const path = kind === 'uppercase source' ? 'tests/regex.test.TS' : 'tests/regex.test.ts';
    const assertion = 'expect(save()).rejects.toThrow("conflict")';
    for (const actual of [false, true]) {
      const body = `const pattern = /"/; /* ${assertion} */\n${actual ? assertion + ';' : 'expect(true).toBe(true);'}`;
      const text = kind === 'scoped method' ? `class Guard {\ncheck() { ${body} }\n}` : `describe("group", () => {\nit("rejects conflict", () => { ${body} });\n});`;
      expect(inspectStructure(path, text).diagnostics).toEqual([]);
      const target = `${path}::symbol:${kind === 'scoped method' ? 'Guard/check' : 'it:rejects conflict'}`;
      const selector = kind === 'whole file' ? path : kind === 'containing parent' ? `${path}::symbol:describe:group` : target;
      const packet = { source: { repo: 'o/r', sha: SHA }, status: 'bounded', evidence: [sourceReceipt(selector, text)], selectionAnchors: parserAnchors(path, text) };
      const result = await judgeQuestion({ repo: 'o/r', required: [{ selector: target, mustContain: [assertion] }], counterevidence: [] }, packet);
      expect(result.requiredEvidenceRecall, `actual assertion: ${actual}`).toBe(actual ? 1 : 0);
      expect(result.taskCompletion.judgment).toBe(actual ? 'evidence-complete' : 'insufficient');
    }
  });

  it.each(['// literal source assertion', '/* literal source assertion */'])('preserves parser-proven JSX text containing %s', async (literal) => {
    const { judgeQuestion } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const path = 'view.tsx';
    const text = `export const view = <pre>${literal}</pre>;`;
    expect(inspectStructure(path, text).diagnostics).toEqual([]);
    for (const selector of [path, `${path}::symbol:view`]) {
      const result = await judgeQuestion({ repo: 'o/r', required: [{ selector: `${path}::symbol:view`, mustContain: [literal] }], counterevidence: [] }, { source: { repo: 'o/r', sha: SHA }, status: 'bounded', evidence: [sourceReceipt(selector, text)] });
      expect(result.taskCompletion.judgment, selector).toBe('evidence-complete');
    }
  });

  it('excludes JSX expression comments while preserving adjacent literal JSX text', async () => {
    const { judgeQuestion } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const path = 'view.tsx';
    const text = 'export const view = <pre>// literal source assertion\n{/* hidden source assertion */}/* literal block text */</pre>;';
    const selector = `${path}::symbol:view`;
    const packet = { source: { repo: 'o/r', sha: SHA }, status: 'bounded', evidence: [sourceReceipt(selector, text)] };
    for (const [assertion, expected] of [['// literal source assertion', 1], ['/* literal block text */', 1], ['hidden source assertion', 0]] as const) {
      const result = await judgeQuestion({ repo: 'o/r', required: [{ selector, mustContain: [assertion] }], counterevidence: [] }, packet);
      expect(result.requiredEvidenceRecall, assertion).toBe(expected);
    }
  });

  it.each(['whole file', 'exact line', 'known prefix'])('does not credit a line inside an original block comment from a %s receipt', async (kind) => {
    const { judgeQuestion } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const path = 'a.ts';
    const assertion = 'expect(save()).rejects.toThrow("conflict")';
    const text = `/*\n${assertion};\n*/\nconst real = true;`;
    const target = `${path}:2-2`;
    const selector = kind === 'whole file' ? path : kind === 'known prefix' ? `${path}:1-2` : target;
    const result = await judgeQuestion({ repo: 'o/r', required: [{ selector: target, mustContain: [assertion] }], counterevidence: [] }, { source: { repo: 'o/r', sha: SHA }, status: 'bounded', evidence: [sourceReceipt(selector, text)], required: [{ selector: target, delivered: true }] });
    expect(result.requiredEvidenceRecall).toBe(0);
    expect(result.taskCompletion.judgment).toBe('insufficient');
    if (kind === 'exact line') expect(result.remainingDelivery).toEqual([target]);
  });

  it.each(['whole file', 'known prefix', 'unknown partial'])('requires original lexical context for real physical lines from a %s receipt', async (kind) => {
    const { judgeQuestion } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const path = 'a.ts';
    const text = '/*\ncomment-only source\n*/\nconst real = true;\nconst tail = true;';
    const target = `${path}:4-4`;
    const selector = kind === 'whole file' ? path : kind === 'known prefix' ? `${path}:1-4` : target;
    const result = await judgeQuestion({ repo: 'o/r', required: [{ selector: target, mustContain: ['const real = true'] }], counterevidence: [] }, { source: { repo: 'o/r', sha: SHA }, status: 'bounded', evidence: [sourceReceipt(selector, text)], required: [{ selector: target, delivered: true }] });
    expect(result.requiredEvidenceRecall).toBe(kind === 'unknown partial' ? 0 : 1);
    expect(result.taskCompletion.judgment).toBe(kind === 'unknown partial' ? 'insufficient' : 'evidence-complete');
  });

  it.each([false, true])('uses JSON parser comment boundaries while preserving quoted slashes (real property: %s)', async (real) => {
    const { judgeQuestion } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const path = 'rules.jsonc';
    const text = `{\n// "protect": true\n/* "protect": true */\n"protect": ${real},\n"url": "https://example.test/a//b",\n"literal": "/* text */"\n}`;
    expect(inspectStructure(path, text).diagnostics).toEqual([]);
    const packet = { source: { repo: 'o/r', sha: SHA }, status: 'bounded', evidence: [sourceReceipt(path, text)] };
    const result = await judgeQuestion({ repo: 'o/r', required: [{ selector: path, mustContain: ['"protect": true'] }], counterevidence: [] }, packet);
    expect(result.requiredEvidenceRecall).toBe(real ? 1 : 0);
    const literals = await judgeQuestion({ repo: 'o/r', required: [{ selector: path, mustContain: ['"url": "https://example.test/a//b"', '"literal": "/* text */"'] }], counterevidence: [] }, packet);
    expect(literals.taskCompletion.judgment).toBe('evidence-complete');
  });

  it('rejects mock dataset and case overrides before running the built-in fixtures', () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-mock-overrides-'));
    try {
      const custom = join(directory, 'questions.json');
      writeFileSync(custom, JSON.stringify([{ id: 'missing-source', repo: 'o/r', question: 'Find missing source', required: [{ selector: 'nonexistent-file.ts', mustContain: ['not present'] }], counterevidence: [] }]));
      writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      for (const override of [['--dataset', custom], ['--case', 'concurrent-edit-conflict']]) {
        const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/evaluate-context.mjs', import.meta.url)), '--mock', ...override], { encoding: 'utf8', env: { ...process.env, PATH: directory + ':' + process.env.PATH } });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('overrides are unsupported');
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('records failed transport as unavailable without fabricating paid-stage or token measurements', async () => {
    const { evaluateQuestions } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const dataset = JSON.parse(readFileSync(new URL('../scripts/context-questions.json', import.meta.url), 'utf8'));
    const report = await evaluateQuestions([dataset[0]], async () => { throw new Error('synthetic private transport diagnostic'); }, { at: SHA });
    expect(report.rows[0]).toMatchObject({ status: 'unavailable', error: 'RUNTIME_TRANSPORT_ERROR', jevStages: null, githubCalls: null });
    expect(report.totals).toMatchObject({ forgeReadCalls: 1, semanticUnreportedReads: 1, githubUnreportedReads: 1 });
    expect(JSON.stringify(report)).not.toContain('private transport diagnostic');
  });
  it('rejects source from the wrong revision or repository while retaining actual usage measurements', async () => {
    const { evaluateQuestions } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const question = { id: 'identity', repo: 'o/r', question: 'Find guard', required: [{ selector: 'a.ts', mustContain: ['guard'] }], counterevidence: [] };
    for (const source of [{ repo: 'o/r', sha: 'b'.repeat(40) }, { repo: 'other/repo', sha: SHA }]) {
      const report = await evaluateQuestions([question], async () => ({ structuredContent: { context: { source, status: 'bounded', evidence: [{ selector: 'a.ts', text: 'guard', representation: 'body' }], inference: [{ usage: { inputTokens: 10, outputTokens: 2 } }] } } }), { at: SHA });
      expect(report.rows[0]).toMatchObject({ error: 'SOURCE_IDENTITY_MISMATCH', initial: { requiredEvidenceRecall: 0, taskCompletion: { judgment: 'insufficient' } } });
      expect(report.totals.usage.inputTokens).toBe(10);
    }
  });
  it('excludes a wrong-revision exact follow-up from evidence grading', async () => {
    const { evaluateQuestions } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const question = { id: 'identity', repo: 'o/r', question: 'Find guard', required: [{ selector: 'a.ts', mustContain: ['guard'] }], counterevidence: [] };
    const report = await evaluateQuestions([question], async (input: any) => ({ structuredContent: input.paths ? { source: { repo: 'o/r', sha: 'b'.repeat(40) }, files: [{ selector: 'a.ts', text: 'guard' }] } : { context: { source: { repo: 'o/r', sha: SHA }, status: 'bounded', evidence: [], omitted: [{ selector: 'a.ts' }] } } }), { at: SHA, followUps: 1 });
    expect(report.rows[0].rounds[1].error).toBe('SOURCE_IDENTITY_MISMATCH');
    expect(report.rows[0].afterReturnedSelectorReads.requiredEvidenceRecall).toBe(0);
  });
});
