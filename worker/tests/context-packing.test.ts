import { describe, expect, it } from 'vitest';
import { packEvidence } from '../src/context-packing';
import { utf8Bytes, type Evidence } from '../src/evidence';
import { selectSymbol } from '../src/structure';
const source = { repo: 'fixture/repo', requested: 'main', sha: 'a'.repeat(40), private: false };
function item(id: string, text: string, mandatory = false): Evidence {
  return { id, kind: 'source', source, path: `${id}.ts`, selector: `${id}.ts`, text, representation: 'body', category: mandatory ? 'instruction' : 'implementation', coverage: 'complete', provenance: 'fixture', limitations: [], mandatory, relevance: 0.8 };
}
function nestedBodies(): { parent: Evidence; child: Evidence } {
  const text = `function owner() {\nfunction guard() { return "${'x'.repeat(10_000)}"; }\nreturn "${'y'.repeat(3500)}";\n}`;
  const body = (symbol: string): Evidence => {
    const selected = selectSymbol('a.ts', text, symbol);
    return { ...item(symbol, selected.text, true), path: 'a.ts', selector: `a.ts::symbol:${symbol}`, range: selected.range, category: 'implementation' };
  };
  return { parent: body('owner'), child: body('owner/guard') };
}
function returnedSize({ source: _source, ...returned }: Evidence): number { return utf8Bytes(JSON.stringify([returned])); }
describe('extractive context packing', () => {
  it('retains mandatory instructions without paraphrasing', () => {
    const rule = item('rules', 'Do not retry uncertain delivery.', true);
    const result = packEvidence([item('large', 'x'.repeat(5000)), rule], 1500);
    expect(result.items).toContainEqual(rule);
    expect(result.items.some((entry) => entry.id === 'large')).toBe(false);
    expect(result.omitted[0]?.reason).toContain('Complete block');
  });
  it('preserves mandatory instruction order', () => {
    const root = item('root', 'Root rule.', true);
    const leaf = item('leaf', 'Leaf rule.', true);
    expect(packEvidence([root, leaf, item('code', 'implementation')], 4000).items.slice(0, 2).map((entry) => entry.id)).toEqual(['root', 'leaf']);
  });
  it('reports mandatory evidence that does not fit', () => {
    const result = packEvidence([item('constraint', 'x'.repeat(3000), true)], 1000);
    expect(result.missingMandatory).toBe(true);
    expect(result.items).toHaveLength(0);
  });
  it('never truncates a source block midway', () => {
    for (let limit = 0; limit < 2000; limit += 37) {
      const evidence = item('build', 'function build() { try { run(); } finally { restore(); } }');
      const result = packEvidence([evidence], limit);
      expect(result.items.every((entry) => entry.text === evidence.text)).toBe(true);
      expect(result.bytes).toBeLessThanOrEqual(limit);
    }
  });
  it('keeps distinct failure evidence even when boilerplate matches', () => {
    const a = item('a', 'test("failed write", () => expect(save()).rejects.toThrow())');
    const b = { ...item('b', 'test("lost lease", () => expect(save()).rejects.toThrow())'), category: 'test' as const, counterEvidence: 0.9, mandatory: true };
    expect(packEvidence([a, b], 4000).items).toHaveLength(2);
  });
  it('accounts for all serialized evidence fields in its byte bound', () => {
    const evidence = { ...item('required', 'body', true), counterEvidence: 0.99 };
    const { source: _source, ...returned } = evidence;
    const bytes = new TextEncoder().encode(JSON.stringify([returned])).length;
    expect(packEvidence([evidence], bytes - 1).missingMandatory).toBe(true);
    expect(packEvidence([evidence], bytes).bytes).toBe(bytes);
  });
  it('lets a containing complete body satisfy all required nested selectors', () => {
    const parent = { ...item('owner', 'function owner() { guard(); }', true), path: 'a.ts', range: { start: 0, end: 30, startLine: 1, endLine: 1 } };
    const child = { ...item('guard', 'guard();', true), path: 'a.ts', range: { start: 19, end: 27, startLine: 1, endLine: 1 } };
    const packed = packEvidence([parent, child], 1000);
    expect(packed.items).toEqual([parent]);
    expect(packed.omitted).toEqual([]);
    expect(packed.missingMandatory).toBe(false);
  });
  it('replaces an already-packed required child with its complete parent when both requirements fit together', () => {
    const { parent, child } = nestedBodies();
    const rule = item('rules', 'Keep complete source and all constraints.', true);
    const budget = returnedSize(rule) + returnedSize(parent);
    const packed = packEvidence([rule, child, parent], budget);
    expect(packed.items.map((entry) => entry.selector)).toEqual([rule.selector, parent.selector]);
    expect(packed.items[1]!.text === parent.text).toBe(true);
    expect(packed.bytes).toBeLessThanOrEqual(budget);
    expect(packed.omitted).toEqual([]);
    expect(packed.missingMandatory).toBe(false);
  });
  it('retains the complete child when its parent cannot fit even after replacement', () => {
    const { parent, child } = nestedBodies();
    const packed = packEvidence([child, parent], returnedSize(child));
    expect(packed.items.map((entry) => entry.selector)).toEqual([child.selector]);
    expect(packed.items[0]!.text === child.text).toBe(true);
    expect(packed.omitted.map((entry) => entry.selector)).toEqual([parent.selector]);
    expect(packed.missingMandatory).toBe(true);
  });
  it.each([true, false])('reconsiders required source after replacement by a parent with mandatory=%s', (mandatory) => {
    const text = `function owner() {\nfunction left() { return "${'x'.repeat(4000)}"; }\nfunction right() { return "${'y'.repeat(4000)}"; }\n}`;
    const body = (symbol: string): Evidence => {
      const selected = selectSymbol('a.ts', text, symbol);
      return { ...item(symbol, selected.text, true), path: 'a.ts', selector: `a.ts::symbol:${symbol}`, range: selected.range, category: 'implementation' };
    };
    const parent = { ...body('owner'), mandatory };
    const left = body('owner/left');
    const right = body('owner/right');
    const other = item('other', `function other() { return "${'z'.repeat(1000)}"; }`, true);
    const noise = item('noise', 'Optional background. '.repeat(10));
    const budget = returnedSize(parent) + returnedSize(other);
    const childBytes = returnedSize(left) + returnedSize(right);
    expect(childBytes).toBeLessThanOrEqual(budget);
    expect(childBytes + returnedSize(other)).toBeGreaterThan(budget);
    const packed = packEvidence([left, right, other, parent, noise], budget);
    expect(packed.items.map((entry) => entry.selector)).toEqual([parent.selector, other.selector]);
    expect(packed.bytes).toBeLessThanOrEqual(budget);
    expect(packed.omitted.map((entry) => entry.selector)).toEqual([noise.selector]);
    expect(packed.missingMandatory).toBe(false);
  });
  it('uses an optional parent to cover missing requirements before unrelated optional text', () => {
    const text = `function owner() {\nfunction left() { return "${'x'.repeat(7870)}"; }\nfunction right() { return "${'y'.repeat(7870)}"; }\n}`;
    const body = (symbol: string, mandatory = true): Evidence => {
      const selected = selectSymbol('a.ts', text, symbol);
      return { ...item(symbol, selected.text, mandatory), path: 'a.ts', selector: `a.ts::symbol:${symbol}`, range: selected.range, category: 'implementation' };
    };
    const parent = body('owner', false);
    const left = body('owner/left');
    const right = body('owner/right');
    const noise = item('noise', 'Optional background. '.repeat(10));
    const budget = 16 * 1024;
    expect(returnedSize(parent)).toBeLessThanOrEqual(budget);
    expect(returnedSize(left) + returnedSize(right)).toBeGreaterThan(budget);
    expect(returnedSize(parent) + returnedSize(noise)).toBeGreaterThan(budget);
    const packed = packEvidence([left, right, parent, noise], budget);
    expect(packed.items.map((entry) => entry.selector)).toEqual([parent.selector]);
    expect(packed.missingMandatory).toBe(false);
    expect(packed.bytes).toBeLessThanOrEqual(budget);
    expect(packed.omitted.map((entry) => entry.selector)).toEqual([noise.selector]);
  });
  it.each(['path', 'revision'])('keeps source from a different %s when a larger block is offered', (difference) => {
    const { parent, child } = nestedBodies();
    const other = difference === 'path' ? { ...parent, path: 'b.ts', selector: 'b.ts::symbol:owner' } : { ...parent, source: { ...source, sha: 'b'.repeat(40) } };
    const packed = packEvidence([child, other], returnedSize(other));
    expect(packed.items.map((entry) => entry.selector)).toEqual([child.selector]);
    expect(packed.missingMandatory).toBe(true);
  });
});
