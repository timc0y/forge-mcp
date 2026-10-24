import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { parseSelector, selectSource } from '../src/selectors';
import { inspectStructure, selectSymbol } from '../src/structure';
import { readRepository } from '../src/repository-reader';
import type { ToolContext } from '../src/tool-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Snapshot } from '../src/snapshot';
import { compileContext } from '../src/context-compiler';
import type { GitHubRequest } from '../src/contracts';
import { semanticEnv } from './helpers/semantic-db';

const SHA = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;

function writeAscii(target: Uint8Array, offset: number, width: number, value: string): void {
  target.set(encoder.encode(value).subarray(0, width), offset);
}
function tarEntry(name: string, content: string, type = '0'): Uint8Array {
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
  header[156] = type.charCodeAt(0);
  writeAscii(header, 257, 6, 'ustar\0');
  writeAscii(header, 263, 2, '00');
  let sum = 0;
  for (const byte of header) sum += byte;
  writeAscii(header, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  out.set(data, 512);
  return out;
}
function tar(files: Record<string, string>): Uint8Array {
  const blocks = [...Object.entries(files).flatMap(([path, content]) => encoder.encode('root/' + path).length > 100
    ? [tarEntry('././@LongLink', 'root/' + path + '\0', 'L'), tarEntry('root/long-name', content)]
    : [tarEntry('root/' + path, content)]), new Uint8Array(1024)];
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
    files['AGENTS.md'] = 'Preserve existing invoice contracts.\n';
    files['tests/AGENTS.md'] = 'Invoice delivery tests must cover duplicate references.\n';
    const archive = tar(files);
    // Simulate GitHub's recursive-tree cap: the relevant implementation and test
    // exist in the immutable archive but are absent from the tree response.
    const tree = Object.entries(files).filter(([path]) => path.startsWith('src/filler-')).slice(0, 40).map(([path, content]) => ({ path, type: 'blob', size: encoder.encode(content).length }));
    const gh: GitHubRequest = async (path) => {
      if (path === '/repos/o/r') return { status: 200, json: { default_branch: 'main', private: false }, text: '', headers: new Headers() };
      if (path === '/repos/o/r/commits/main') return { status: 200, json: { sha: SHA }, text: '', headers: new Headers() };
      if (path.startsWith('/repos/o/r/git/trees/')) return { status: 200, json: { truncated: true, tree }, text: '', headers: new Headers() };
      if (path.startsWith('/repos/o/r/tarball/')) return { status: 200, json: null, text: '', headers: new Headers(), stream: new Blob([new Uint8Array(archive)]).stream() };
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
        const testId = state.candidates.find((entry: any) => entry.path === 'tests/core.test.ts')?.id;
        answers.gap = { type: 'choice', choice: 'test', confidence: 0.9, probabilities: distribution(Object.keys(questions.gap.criteria), 'test') };
        answers.target = { type: 'choice', choice: testId, confidence: 0.9, probabilities: distribution(targets, testId) };
      } else {
        for (const id of Object.keys(questions)) {
          if (id.startsWith('primary_')) answers[id] = { type: 'noul', noul: state.candidates[Number(id.split('_')[1])]?.path === 'src/core.ts' ? 0.99 : 0.01 };
          else if (id.startsWith('relevant_')) answers[id] = { type: 'noul', noul: 0.95 };
          else if (id.startsWith('counter_')) answers[id] = { type: 'noul', noul: 0.2 };
          else answers[id] = { type: 'choice', choice: 'body', confidence: 0.9, probabilities: { body: 0.9, outline: 0.1 } };
        }
      }
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { state: 'Completed', result: { model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 5 } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const snapshot = await Snapshot.open(gh, { owner: 'o', name: 'r' });
    const env = semanticEnv();
    const packet = await compileContext(snapshot, env, 'why can duplicate invoice delivery fail?') as any;
    expect(packet.evidence.some((item: any) => item.selector === 'src/core.ts::symbol:submitInvoiceDelivery')).toBe(true);
    expect(packet.evidence.some((item: any) => item.path === 'tests/core.test.ts')).toBe(true);
    expect(packet.evidence.some((item: any) => item.path === 'tests/AGENTS.md' && item.mandatory)).toBe(true);
    expect(packet.evidence.filter((item: any) => item.path === 'AGENTS.md')).toHaveLength(1);
    expect(packet.relationships.some((edge: any) => edge.from === 'tests/core.test.ts' && edge.to === 'src/core.ts')).toBe(true);
    expect(packet.limitations.join(' ')).toContain('GitHub tree coverage is incomplete');
    expect(packet.limitations.join(' ')).toContain('structurally summarized candidates');
  });

  it.each([false, true])('finds a generic graph dependency and reports rejected evidence as insufficient (reject evidence: %s)', async (rejectEvidence) => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 70; index++) {
      files['src/decoy-' + String(index).padStart(2, '0') + '.ts'] = '// invoice reconciliation invoice reconciliation\nexport const value' + index + ' = ' + index + ';\n';
    }
    files['src/invoice-route.ts'] = '// invoice reconciliation invoice reconciliation invoice reconciliation invoice reconciliation\nimport { persist } from "./helper";\nexport function route(value: string) { return persist(value); }\n';
    files['src/helper.ts'] = 'export function persist(value: string) { if (!value) throw new Error("required"); return value; }\n';
    const zipped = tar(files);
    const tree = Object.entries(files).map(([path, content]) => ({ path, type: 'blob', size: encoder.encode(content).length }));
    const gh: GitHubRequest = async (path) => {
      if (path === '/repos/o/r') return { status: 200, json: { default_branch: 'main', private: false }, text: '', headers: new Headers() };
      if (path === '/repos/o/r/commits/main') return { status: 200, json: { sha: SHA }, text: '', headers: new Headers() };
      if (path.startsWith('/repos/o/r/git/trees/')) return { status: 200, json: { truncated: false, tree }, text: '', headers: new Headers() };
      if (path.startsWith('/repos/o/r/tarball/')) return { status: 200, json: null, text: '', headers: new Headers(), stream: new Blob([new Uint8Array(zipped)]).stream() };
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
        for (const id of Object.keys(questions)) {
          const index = Number(id.split('_')[1]);
          answers[id] = { type: 'noul', noul: state.candidates[index]?.path === 'src/helper.ts' ? 0.99 : 0.01 };
        }
      } else if (questions.gap) {
        answers.gap = { type: 'choice', choice: 'none', confidence: 0.9, probabilities: distribution(Object.keys(questions.gap.criteria), 'none') };
        answers.target = { type: 'choice', choice: 'none', confidence: 0.9, probabilities: distribution(Object.keys(questions.target.criteria), 'none') };
      } else {
        for (const [id] of Object.entries(questions)) {
          if (id.startsWith('primary_')) answers[id] = { type: 'noul', noul: rejectEvidence ? 0.01 : 0.99 };
          else if (id.startsWith('relevant_')) answers[id] = { type: 'noul', noul: rejectEvidence ? 0.01 : 0.99 };
          else if (id.startsWith('counter_')) answers[id] = { type: 'noul', noul: 0.1 };
          else answers[id] = { type: 'choice', choice: 'body', confidence: 0.9, probabilities: { body: 0.9, outline: 0.1 } };
        }
      }
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { state: 'Completed', result: { model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 5 } } } }), { status: 200 });
    }) as typeof fetch;

    const snapshot = await Snapshot.open(gh, { owner: 'o', name: 'r' });
    const packet = await compileContext(snapshot, semanticEnv(), 'investigate invoice reconciliation') as any;
    if (rejectEvidence) {
      expect(packet.evidence).toEqual([]);
      expect(packet.status).toBe('insufficient');
    } else {
      expect(packet.evidence.some((item: any) => item.selector === 'src/helper.ts::symbol:persist')).toBe(true);
    }
  });
});

function sourceGitHub(files: Record<string, string>): GitHubRequest {
  const zipped = tar(files);
  const reply = (json: unknown) => ({ status: 200, json, text: '', headers: new Headers() });
  return async (path) => {
    if (path === '/repos/o/r') return reply({ default_branch: 'main', private: false });
    if (path === '/repos/o/r/commits/main') return reply({ sha: SHA });
    if (path.startsWith('/repos/o/r/pulls')) return reply([]);
    if (path.startsWith('/repos/o/r/git/trees/')) return reply({ truncated: false, tree: Object.entries(files).map(([path, text]) => ({ path, type: 'blob', size: encoder.encode(text).length })) });
    if (path.startsWith('/repos/o/r/tarball/')) return { ...reply(null), stream: new Blob([new Uint8Array(zipped)]).stream() };
    const match = /^\/repos\/o\/r\/contents\/(.+)\?ref=/.exec(path);
    const content = match && files[decodeURIComponent(match[1]!)];
    if (typeof content === 'string') return reply({ type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64'), size: encoder.encode(content).length, sha: BLOB });
    throw new Error(`Unexpected source fixture request: ${path}`);
  };
}
interface MockCandidate { id: string; path: string; selector?: string; text?: string; previewOnly?: boolean; previewCoverage?: string }
function semanticFixture(options: {
  paths?: (path: string) => boolean;
  primary?: (candidate: MockCandidate) => boolean;
  counter?: (candidate: MockCandidate) => boolean;
  gap?: string;
  expansion?: (candidate: MockCandidate) => boolean;
  observe?: (stage: string, state: any) => void;
  model?: string;
} = {}): void {
  globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
    const { input } = JSON.parse(String(init?.body));
    const { state, questions } = input;
    const stage = questions.gap ? 'gap' : Object.hasOwn(questions, 'file_0') ? 'files' : 'evidence';
    options.observe?.(stage, state);
    const answers: Record<string, unknown> = {};
    for (const key of Object.keys(questions)) {
      const candidate = state.candidates[Number(key.split('_')[1])] as MockCandidate;
      if (stage === 'files') answers[key] = { type: 'noul', noul: (options.paths?.(candidate.path) ?? candidate.path.endsWith('.ts')) ? 0.99 : 0.01 };
      else if (stage === 'gap') {
        const winner = key === 'gap' ? options.gap ?? 'none' : state.candidates.find((item: MockCandidate) => options.expansion?.(item))?.id ?? 'none';
        answers[key] = { type: 'choice', choice: winner, confidence: 0.9, probabilities: distribution(Object.keys(questions[key].criteria), winner) };
      } else if (key.startsWith('detail_')) answers[key] = { type: 'choice', choice: 'body', confidence: 0.9, probabilities: { body: 0.9, outline: 0.1 } };
      else answers[key] = { type: 'noul', noul: key.startsWith('primary_') ? ((options.primary?.(candidate) ?? true) ? 0.99 : 0.01) : key.startsWith('counter_') ? (options.counter?.(candidate) ? 0.9 : 0.01) : 0.5 };
    }
    return Response.json({ success: true, errors: [], messages: [], result: { state: 'Completed', result: { model: options.model ?? 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 20 } } } });
  }) as typeof fetch;
}
async function contextFor(files: Record<string, string>, goal = 'Return implementation AND regression test proving the conflict path.') {
  return await compileContext(await Snapshot.open(sourceGitHub(files), { owner: 'o', name: 'r' }), semanticEnv(), goal) as any;
}

describe('required evidence and recoverable context selection', () => {
  it.each([70, 110])('bounds the no-block envelope with oversized instructions and long archive omissions (path segments: %i)', async (segments) => {
    const instructions = '# Rules\n' + 'Preserve literal source and recover every omitted obligation.\n'.repeat(250);
    const files: Record<string, string> = { 'AGENTS.md': instructions, 'src/broken.ts': 'export function broken( {' };
    for (let index = 0; index < 50; index++) files[`assets/${String(index).padStart(2, '0')}-${'nested-'.repeat(segments)}.bin`] = '\0binary';
    semanticFixture({ paths: (path) => path === 'src/broken.ts' });
    const packet = await contextFor(files);
    expect(packet.status).toBe('insufficient');
    expect(encoder.encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(32 * 1024);
    if (segments === 110) {
      expect(packet.metadataBounded).toBe(true);
      expect(packet.limitationsCoverage).toMatchObject({ complete: false, total: 52 });
    } else expect(packet.limitations.filter((item: string) => item.endsWith(': binary'))).toHaveLength(50);
    expect(packet.omitted).toContainEqual(expect.objectContaining({ selector: 'src/broken.ts', followUp: 'src/broken.ts', stage: 'structure' }));
    const requirement = packet.required.find((item: any) => item.selector === 'AGENTS.md');
    expect(requirement).toBeDefined();
    if (requirement.delivered) expect(packet.evidence.find((item: any) => item.selector === 'AGENTS.md').text).toBe(instructions);
    else {
      expect(packet.recoverySelectors).toContain(`AGENTS.md:1-${instructions.split('\n').length - 1}`);
      expect(packet.unverified).toContain('Required source not delivered: AGENTS.md');
      expect(packet.omitted).toContainEqual(expect.objectContaining({ selector: 'AGENTS.md', followUp: 'AGENTS.md:1-80', stage: 'packing' }));
    }
    expect(packet.unverified).toContain('No implementation blocks could be selected.');
    expect(encoder.encode(JSON.stringify(packet.selectionAnchors)).length).toBeLessThanOrEqual(2048);
    expect(packet.selectionAnchorCoverage).toMatchObject({ total: 1, listed: 1, complete: true });
    expect(packet.budget.jevStages).toBe(1);
  });

  it('bounds an empty semantic selection and explicitly omits an oversized model identity', async () => {
    semanticFixture({ paths: () => false, model: 'jev-' + 'm'.repeat(40_000) });
    const packet = await contextFor({ 'src/guard.ts': 'function guard() { return false; }' });
    expect(packet.status).toBe('insufficient');
    expect(encoder.encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(32 * 1024);
    expect(packet.model).toMatchObject({ returned: null, modelIdentityOmitted: true, pinned: false });
    expect(packet.inference).toEqual([expect.objectContaining({ model: null, modelIdentityOmitted: true, accounting: 'settled', usage: { inputTokens: 100, outputTokens: 20 } })]);
    expect(packet.evidence).toEqual([]);
    expect(packet.selectionAnchorCoverage).toEqual({ total: 0, listed: 0, complete: true });
    expect(packet.budget.jevStages).toBe(1);
  });

  it('bounds unreadable-source metadata even before semantic selection', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 50; index++) files[`assets/${index}-${'nested-'.repeat(110)}.bin`] = '\0binary';
    globalThis.fetch = vi.fn(() => { throw new Error('No readable source must not invoke JEV.'); }) as typeof fetch;
    const packet = await contextFor(files);
    expect(packet.status).toBe('insufficient');
    expect(encoder.encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(32 * 1024);
    expect(packet.limitationsCoverage).toMatchObject({ complete: false, total: 52 });
    expect(packet.budget.jevStages).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('protects every requested primary block and labels packing loss insufficient', async () => {
    const files = {
      'src/guard.ts': 'export function guard() { throw new Error("conflict"); }',
      'tests/guard.test.ts': 'it("rejects conflict", () => { const padding = "' + 'x'.repeat(17_000) + '"; expect(guard()).rejects.toThrow(); });'
    };
    semanticFixture();
    const packet = await contextFor(files);
    expect(packet.status).toBe('insufficient');
    expect(packet.required).toEqual(expect.arrayContaining([
      { selector: 'src/guard.ts::symbol:guard', delivered: true },
      { selector: 'tests/guard.test.ts::symbol:it:rejects conflict', delivered: false }
    ]));
    expect(packet.omitted).toContainEqual(expect.objectContaining({ selector: 'tests/guard.test.ts::symbol:it:rejects conflict', stage: 'packing' }));
    expect(packet.unverified.join(' ')).toContain('tests/guard.test.ts::symbol:it:rejects conflict');
    expect(packet.selectionAnchors).toContainEqual({ selector: 'tests/guard.test.ts::symbol:it:rejects conflict', range: selectSource(parseSelector('tests/guard.test.ts::symbol:it:rejects conflict'), files['tests/guard.test.ts']).range });
    expect(packet.budget.jevStages).toBe(3);
    expect(packet.inference).toHaveLength(3);
    expect(packet.inference.every((stage: any) => stage.accounting === 'settled')).toBe(true);
  });

  it('retains useful owner evidence when an optional imported neighbor is binary', async () => {
    semanticFixture({ paths: (path) => path === 'src/owner.ts', gap: 'implementation' });
    const packet = await contextFor({ 'src/owner.ts': 'import asset from "./asset.bin"; export function owner() { return asset; }', 'src/asset.bin': '\0binary' });
    expect(packet.status).toBe('insufficient');
    expect(packet.evidence).toContainEqual(expect.objectContaining({ selector: 'src/owner.ts::symbol:owner' }));
    expect(packet.omitted).toContainEqual(expect.objectContaining({ selector: 'src/asset.bin', stage: 'expansion-read', code: 'FORGE_VALIDATION_FAILED' }));
    expect(packet.unverified.join(' ')).toContain('implementation gap remains unverified');
    expect(packet.budget.jevStages).toBe(3);
  });

  it.each([300, 900])('fits the full envelope with 24 required tests whose titles are %i characters', async (length) => {
    const titles = Array.from({ length: 24 }, (_, index) => `${index}-` + 'concurrent conflict '.repeat(60)).map((title) => title.slice(0, length));
    const source = titles.map((title) => `it("${title}", () => expect(commitFiles()).rejects.toThrow("conflict"));`).join('\n');
    semanticFixture();
    const packet = await contextFor({ 'tests/conflicts.test.ts': source });
    expect(packet.status).toBe('insufficient');
    expect(encoder.encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(32 * 1024);
    expect(packet.evidence.length).toBeGreaterThan(0);
    for (const item of packet.evidence) expect(item.text).toBe(selectSource(parseSelector(item.selector), source).text);
    expect(packet.omitted.length).toBeGreaterThan(0);
    expect(packet.required.some((item: any) => !item.delivered)).toBe(true);
    expect(encoder.encode(JSON.stringify(packet.selectionAnchors)).length).toBeLessThanOrEqual(2048);
    expect(packet.selectionAnchorCoverage).toMatchObject({ total: 24, listed: packet.selectionAnchors.length, complete: false });
    for (const anchor of packet.selectionAnchors) expect(anchor.range).toEqual(selectSource(parseSelector(anchor.selector), source).range);
    if (length === 900) expect(packet.requiredCoverage).toMatchObject({ complete: false, total: 24 });
    expect(packet.budget.jevStages).toBe(3);
  });

  it('returns a short exact recovery range when an expansion symbol identity alone exceeds the response ceiling', async () => {
    const title = 'conflict-' + 'x'.repeat(40_000);
    const test = `import { owner } from "../src/owner";\nit("${title}", () => expect(owner()).toBe(false));`;
    semanticFixture({ paths: (path) => path === 'src/owner.ts', gap: 'test', expansion: (item) => item.path === 'tests/owner.test.ts' });
    const packet = await contextFor({ 'src/owner.ts': 'export function owner() { return false; }', 'tests/owner.test.ts': test });
    expect(packet.status).toBe('insufficient');
    expect(encoder.encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(32 * 1024);
    expect(packet.evidence).toContainEqual(expect.objectContaining({ selector: 'src/owner.ts::symbol:owner' }));
    expect(packet.gap.selector).toBe('tests/owner.test.ts:2-2');
    expect(packet.recoverySelectors).toContain('tests/owner.test.ts:2-2');
    expect(selectSource(parseSelector(packet.gap.selector), test).text).toContain(title);
    expect(encoder.encode(JSON.stringify(packet.selectionAnchors)).length).toBeLessThanOrEqual(2048);
    expect(packet.selectionAnchorCoverage).toMatchObject({ total: 2, listed: 1, complete: false });
  });

  it('bounds and deduplicates original child anchors covered by a delivered parent', async () => {
    const text = 'class Guard {\n' + Array.from({ length: 30 }, (_, index) => `method${index}${'x'.repeat(100)}() { return false; }`).join('\n') + '\n}';
    const path = 'src/guard.ts';
    semanticFixture({ primary: (candidate) => candidate.selector === `${path}::symbol:Guard` });
    const packet = await contextFor({ [path]: text }, 'Return the Guard class implementation.');
    expect(packet.evidence).toContainEqual(expect.objectContaining({ selector: `${path}::symbol:Guard`, text }));
    expect(packet.selectionAnchors[0].selector).toBe(`${path}::symbol:Guard`);
    expect(packet.selectionAnchorCoverage).toMatchObject({ total: inspectStructure(path, text).blocks.length, listed: packet.selectionAnchors.length, complete: false });
    expect(new Set(packet.selectionAnchors.map((anchor: any) => anchor.selector)).size).toBe(packet.selectionAnchors.length);
    expect(encoder.encode(JSON.stringify(packet.selectionAnchors)).length).toBeLessThanOrEqual(2048);
    expect(encoder.encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(32 * 1024);
    for (const anchor of packet.selectionAnchors) expect(anchor.range).toEqual(selectSource(parseSelector(anchor.selector), text).range);
  });

  it('keeps required child identities unverified when their original anchors do not fit', async () => {
    const text = 'class Guard {\n' + Array.from({ length: 23 }, (_, index) => `method${index}${'x'.repeat(200)}() { return false; }`).join('\n') + '\n}';
    const path = 'src/guard.ts';
    semanticFixture();
    const packet = await contextFor({ [path]: text });
    expect(packet.evidence).toContainEqual(expect.objectContaining({ selector: `${path}::symbol:Guard`, text }));
    expect(packet.selectionAnchorCoverage.complete).toBe(false);
    const missing = packet.required.find((item: any) => !item.delivered);
    expect(missing).toBeDefined();
    expect(packet.selectionAnchors.some((anchor: any) => anchor.selector === missing.selector)).toBe(false);
    expect(packet.unverified).toContain(`Required source not delivered: ${missing.selector}`);
    expect(packet.status).toBe('insufficient');
    expect(encoder.encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(32 * 1024);
  });

  it('does not require redundant anchors for directly delivered exact bodies', async () => {
    const path = 'src/direct.ts';
    const text = Array.from({ length: 3 }, (_, index) => `function guard${index}${'x'.repeat(900)}() { return false; }`).join('\n');
    semanticFixture();
    const packet = await contextFor({ [path]: text });
    expect(packet.selectionAnchorCoverage).toMatchObject({ total: 3, complete: false });
    expect(packet.required).toHaveLength(3);
    expect(packet.required.every((item: any) => item.delivered)).toBe(true);
    expect(packet.unverified).toEqual([]);
    expect(packet.status).toBe('bounded');
  });

  it.each([false, true])('withholds globally colliding named receipts and returns valid recovery selectors (parent: %s)', async (parent) => {
    const path = 'tests/collision.test.ts';
    const body = [
      'it("rejects", () => expect(save()).rejects.toThrow("conflict"));',
      'it("rejects", () => expect(true).toBe(true));',
      'it("rejects[0]", () => expect(true).toBe(true));'
    ].join('\n');
    const text = parent ? `describe("group", () => {\n${body}\n});` : body;
    const selector = `${path}::symbol:it:rejects[0]`;
    const structure = inspectStructure(path, text);
    const collisions = structure.blocks.filter((block) => `${path}::symbol:${block.name}` === selector);
    expect(collisions).toHaveLength(2);
    expect(() => selectSource(parseSelector(selector), text)).toThrow(/matched 2 declarations/);
    semanticFixture();
    const packet = await contextFor({ [path]: text });
    expect(packet.selectionAnchors.some((anchor: any) => anchor.selector === selector)).toBe(false);
    expect(packet.evidence.some((item: any) => item.selector === selector)).toBe(false);
    for (const collision of collisions) {
      const followUp = `${path}:${collision.range.startLine}-${collision.range.endLine}`;
      expect(packet.omitted).toContainEqual(expect.objectContaining({ selector, stage: 'structure-identity', followUp }));
      expect(packet.recoverySelectors).toContain(followUp);
      expect(selectSource(parseSelector(followUp), text).text).toContain(collision.text);
    }
    const { judgeQuestion } = await import(new URL('../scripts/evaluate-context.mjs', import.meta.url).href);
    const question = { repo: 'o/r', required: [{ selector, mustContain: ['expect(save()).rejects.toThrow("conflict")'] }], counterevidence: [] };
    expect((await judgeQuestion(question, packet)).taskCompletion.judgment).toBe('insufficient');
    if (parent) expect(packet.evidence).toContainEqual(expect.objectContaining({ selector: `${path}::symbol:describe:group`, text }));
    expect(packet.required).toContainEqual({ selector: `${path}::symbol:it:rejects[1]`, delivered: true });
    expect(encoder.encode(JSON.stringify(packet.selectionAnchors)).length).toBeLessThanOrEqual(2048);
    expect(encoder.encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(32 * 1024);
  });

  it('retains line recovery when colliding names exceed the omission metadata budget', async () => {
    const path = 'tests/long-collision.test.ts';
    const name = 'rejects-' + 'x'.repeat(4000);
    const text = [name, name, `${name}[0]`, `${name}[1]`].map((title) => `it("${title}", () => expect(true).toBe(true));`).join('\n');
    semanticFixture();
    const packet = await contextFor({ [path]: text });
    expect(packet.status).toBe('insufficient');
    expect(packet.evidence).toEqual([]);
    expect(packet.selectionAnchors).toEqual([]);
    expect(packet.omissionCoverage).toMatchObject({ total: 4, listed: 0, complete: false, byStage: { 'structure-identity': 4 } });
    expect(packet.recoverySelectors).toHaveLength(4);
    for (let line = 1; line <= 4; line++) {
      const selector = `${path}:${line}-${line}`;
      expect(packet.recoverySelectors).toContain(selector);
      expect(selectSource(parseSelector(selector), text).text).toContain('expect(true).toBe(true)');
    }
    expect(encoder.encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(32 * 1024);
  });

  it('does not hide a failed required instruction read as an optional-neighbor omission', async () => {
    semanticFixture();
    await expect(contextFor({ 'AGENTS.md': '\0binary', 'src/owner.ts': 'function owner() {}' })).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
  });

  it('offers a real ninth block behind eight stronger keyword decoys to JEV', async () => {
    const decoys = Array.from({ length: 8 }, (_, i) => `function decoy${i}() { return "implementation regression test proving conflict path"; }`).join('\n');
    semanticFixture({ primary: (item) => item.selector?.endsWith(':guard') ?? false });
    const packet = await contextFor({ 'src/guard.ts': decoys + '\nfunction guard(paths: string[], changed: Set<string>) { if (paths.some(path => changed.has(path))) throw new Error("overlap"); }' });
    expect(packet.status).toBe('bounded');
    expect(packet.evidence).toContainEqual(expect.objectContaining({ selector: 'src/guard.ts::symbol:guard', mandatory: true }));
  });

  it('names upstream file and block cuts rather than hiding them behind a packing-only omission list', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 55; i++) files[`src/file-${String(i).padStart(2, '0')}.ts`] = Array.from({ length: 5 }, (_, j) => `export function block${j}() { return "conflict"; }`).join('\n');
    semanticFixture({ primary: (item) => item.selector?.endsWith(':block0') ?? false });
    const packet = await contextFor(files, 'conflict');
    expect(packet.omissionCoverage.byStage['file-shortlist']).toBeGreaterThan(0);
    expect(packet.omissionCoverage.byStage['selected-files']).toBeGreaterThan(0);
    expect(packet.omissionCoverage.byStage['evidence-shortlist']).toBeGreaterThan(0);
    expect(packet.omitted.some((item: any) => item.stage === 'evidence-shortlist' && item.selector.includes('::symbol:'))).toBe(true);
    expect(packet.omissionCoverage.total).toBeGreaterThanOrEqual(packet.omitted.length);
    expect(encoder.encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(32 * 1024);
  });

  it('keeps instruction sections after the former sixth-section cut as literal mandatory source', async () => {
    const instructions = Array.from({ length: 9 }, (_, i) => `## Rule ${i}\n${'preserve this obligation. '.repeat(42)}\n`).join('\n');
    semanticFixture();
    const packet = await contextFor({ 'AGENTS.md': instructions, 'src/guard.ts': 'function guard() { return false; }' });
    expect(packet.status).toBe('bounded');
    expect(packet.evidence).toContainEqual(expect.objectContaining({ selector: 'AGENTS.md', mandatory: true, text: instructions }));
  });

  it('keeps oversized instruction obligations unverified with a valid exact line recovery', async () => {
    const instructions = '# Rules\n' + 'Preserve every rule.\n'.repeat(1500);
    semanticFixture();
    const packet = await contextFor({ 'AGENTS.md': instructions, 'src/guard.ts': 'function guard() { return false; }' });
    expect(packet.status).toBe('insufficient');
    expect(packet.required).toContainEqual({ selector: 'AGENTS.md', delivered: false });
    const omitted = packet.omitted.find((item: any) => item.selector === 'AGENTS.md');
    expect(omitted).toMatchObject({ stage: 'packing', followUp: 'AGENTS.md:1-80' });
    expect(selectSource(parseSelector(omitted.followUp), instructions).text).toContain('Preserve every rule.');
    expect(packet.limitations.join(' ')).toContain('oversized instructions');
  });

  it('shows a task-relevant middle guard while disclosing that the preview is incomplete', async () => {
    let preview: MockCandidate | undefined;
    const body = 'function guard() {\n' + '  touch();\n'.repeat(400) + '  if (concurrentChange) throw new Error("conflict");\n' + '  touch();\n'.repeat(400) + '}';
    semanticFixture({ observe: (stage, state) => { if (stage === 'evidence') preview = state.candidates[0]; } });
    const packet = await contextFor({ 'src/guard.ts': body }, 'Where is concurrentChange rejected?');
    expect(preview?.text).toContain('if (concurrentChange)');
    expect(preview?.previewOnly).toBe(true);
    expect(preview?.previewCoverage).toContain('omitted source was not seen');
    expect(encoder.encode(preview!.text!).length).toBeLessThanOrEqual(2500);
    expect(packet.evidence[0].text).toBe(body);
  });

  it('keeps multiple unresolved obligations insufficient after delivering one helpful expansion', async () => {
    semanticFixture({ paths: (path) => path === 'src/guard.ts', gap: 'incomplete', expansion: (item) => item.path === 'tests/guard.test.ts' });
    const packet = await contextFor({ 'src/guard.ts': 'export function guard() { return false; }', 'tests/guard.test.ts': 'import { guard } from "../src/guard"; it("rejects", () => expect(guard()).toBe(false));' });
    expect(packet.status).toBe('insufficient');
    expect(packet.gap).toMatchObject({ category: 'incomplete', addressed: false });
    expect(packet.unverified.join(' ')).toContain('incomplete gap remains unverified');
  });

  it.each([
    ['guide.md', '# Conflict\nPreserve concurrent edits.', '@lezer/markdown/'],
    ['config.yaml', 'conflict: refuse\n', 'yaml/'],
    ['section.liquid', '<div>conflict</div>', '@shopify/liquid-html-parser/']
  ])('records the actual parser for %s', async (path, text, parser) => {
    semanticFixture({ paths: () => true });
    const packet = await contextFor({ [path]: text }, 'conflict');
    expect(packet.evidence[0].provenance).toContain(parser);
  });

  it('reports an identified regression gap as insufficient when no shown source supplies it', async () => {
    semanticFixture({ gap: 'test' });
    const packet = await contextFor({ 'src/guard.ts': 'function guard() { throw new Error("conflict"); }' });
    expect(packet.status).toBe('insufficient');
    expect(packet.unverified.join(' ')).toContain('test gap remains unverified');
  });
});

const realWrite = readFileSync(new URL('../src/write.ts', import.meta.url), 'utf8');
const realRegression = readFileSync(new URL('./write-regressions.test.ts', import.meta.url), 'utf8');
const CONFLICT_QUESTION = 'Where does Forge stop an edit from overwriting a concurrent change to the same file? Return implementation and regression test proving conflict path.';

describe('Forge conflict evidence from real repository source', () => {
  it('selects the actual conflict regression from evidence instead of a stronger lexical fake', async () => {
    const files = {
      'worker/src/write.ts': realWrite,
      'worker/tests/write-regressions.test.ts': 'it("implementation regression test proving conflict path concurrent same file overwriting", () => expect(true).toBe(true));\n' + realRegression,
      'AGENTS.md': 'Keep complete conflict behavior and regression evidence.'
    };
    let sawGuard = false;
    let sawRealRegression = false;
    semanticFixture({
      paths: (path) => path === 'worker/src/write.ts',
      primary: (item) => item.selector?.endsWith(':assertNoOverlap') ?? false,
      gap: 'test',
      expansion: (item) => item.selector?.endsWith(':it:refuses to resurrect a concurrently renamed path') ?? false,
      observe: (stage, state) => {
        if (stage === 'gap') {
          sawGuard = state.selected.some((item: MockCandidate) => item.text?.includes('FORGE_CONFLICT'));
          sawRealRegression = state.candidates.some((item: MockCandidate) => item.text?.includes('fixture.trees).toHaveLength(1)') && item.text.includes('FORGE_CONFLICT'));
        }
      }
    });
    const packet = await contextFor(files, CONFLICT_QUESTION);
    expect(sawGuard).toBe(true);
    expect(sawRealRegression).toBe(true);
    expect(packet.status).toBe('bounded');
    const implementation = packet.evidence.find((item: any) => item.selector === 'worker/src/write.ts::symbol:assertNoOverlap');
    expect(implementation.text).toBe(selectSymbol('worker/src/write.ts', realWrite, 'assertNoOverlap').text);
    expect(implementation.text).toContain('collisions.length > 0');
    const regression = packet.evidence.find((item: any) => item.selector.endsWith(':it:refuses to resurrect a concurrently renamed path'));
    expect(regression.text).toContain('commitFiles(');
    expect(regression.text).toContain('FORGE_CONFLICT');
    expect(regression.mandatory).toBe(true);
    expect(regression.text).not.toContain('expect(true)');
  });

  it('returns the actual ordinary same-file conflict regression instead of a keyword-only test', async () => {
    const title = 'refuses a concurrent modification of the same file before a second commit';
    const path = 'worker/tests/write-safety.test.ts';
    const realSafety = readFileSync(new URL('./write-safety.test.ts', import.meta.url), 'utf8');
    semanticFixture({ paths: (path) => path === 'worker/src/write.ts', primary: (item) => item.selector?.endsWith(':assertNoOverlap') ?? false, gap: 'test', expansion: (item) => item.selector === `${path}::symbol:it:${title}` });
    const packet = await contextFor({ 'worker/src/write.ts': realWrite, [path]: 'it("overwriting concurrent change same file implementation regression test proving conflict path", () => expect(true).toBe(true));\n' + realSafety }, CONFLICT_QUESTION);
    expect(packet.status).toBe('bounded');
    const regression = packet.evidence.find((item: any) => item.selector === `${path}::symbol:it:${title}`);
    expect(regression.text).toContain("filename: 'a.md', status: 'modified'");
    expect(regression.text).toContain('FORGE_CONFLICT');
    expect(regression.text).toContain("call.path === '/graphql'");
    expect(regression.text).toContain('toHaveLength(1)');
    expect(regression.text).not.toContain('expect(true)');
  });

  it('keeps the real guard and its commitFiles caller as distinct required evidence when both are requested', async () => {
    semanticFixture({ primary: (item) => /::symbol:(?:assertNoOverlap|commitFiles)$/.test(item.selector ?? '') });
    const packet = await contextFor({ 'worker/src/write.ts': realWrite }, 'Show assertNoOverlap and its commitFiles caller where Forge refuses concurrent same-file changes.');
    expect(packet.status).toBe('bounded');
    for (const symbol of ['assertNoOverlap', 'commitFiles']) expect(packet.required).toContainEqual({ selector: `worker/src/write.ts::symbol:${symbol}`, delivered: true });
    expect(packet.evidence.find((item: any) => item.selector.endsWith(':commitFiles')).text).toContain('await assertNoOverlap(');
  });

  it('keeps exact assertNoOverlap reads direct without any semantic call or metadata database', async () => {
    const requests: string[] = [];
    const gh = sourceGitHub({ 'worker/src/write.ts': realWrite });
    globalThis.fetch = vi.fn(() => { throw new Error('Exact reads must not invoke JEV.'); }) as typeof fetch;
    const ctx = { env: {}, identity: { githubLogin: 'o' }, gh: async (path: string, init: any) => { requests.push(path); return gh(path, init); }, ghUser: gh, track: () => {} } as unknown as ToolContext;
    const result = await readRepository(ctx, { repo: 'o/r', paths: ['worker/src/write.ts::symbol:assertNoOverlap'], query: CONFLICT_QUESTION });
    const structured = result.structured as any;
    expect(structured.files[0].text).toBe(selectSymbol('worker/src/write.ts', realWrite, 'assertNoOverlap').text);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(requests.some((path) => /tarball|git\/trees/.test(path))).toBe(false);
    expect(requests.length).toBeLessThanOrEqual(5);
  });
});
