import { describe, expect, it } from 'vitest';
import { packEvidence } from '../src/context-packing';
import type { Evidence } from '../src/evidence';
const source = { repo: 'fixture/repo', requested: 'main', sha: 'a'.repeat(40), private: false };
function item(id: string, text: string, mandatory = false): Evidence {
  return { id, kind: 'source', source, path: `${id}.ts`, selector: `${id}.ts`, text, representation: 'body', category: mandatory ? 'instruction' : 'implementation', coverage: 'complete', provenance: 'fixture', limitations: [], mandatory, relevance: 0.8 };
}
describe('extractive context packing', () => {
  it('retains mandatory instructions without paraphrasing', () => {
    const rule = item('rules', 'Do not retry uncertain delivery.', true);
    const result = packEvidence([item('large', 'x'.repeat(5000)), rule], 1500);
    expect(result.items).toContainEqual(rule);
    expect(result.items.some((entry) => entry.id === 'large')).toBe(false);
    expect(result.omitted[0]?.reason).toContain('Complete block');
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
});
