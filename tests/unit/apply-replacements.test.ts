import { describe, expect, it } from 'vitest';
import { applyReplacements, ReplacementFailed } from '../../apps/forge-edge-gateway/src/apply-replacements';

const file = 'const a = 1;\nconst b = 2;\nconst a = 1;\n';

describe('applyReplacements', () => {
  it('applies an unambiguous fragment', () => {
    expect(applyReplacements('f.ts', 'const b = 2;\n', [{ old: 'b = 2', new: 'b = 3' }]))
      .toBe('const b = 3;\n');
  });

  it('refuses an ambiguous fragment rather than guessing', () => {
    // Taking the first match would silently edit a line the agent never meant.
    expect(() => applyReplacements('f.ts', file, [{ old: 'const a = 1;', new: 'const a = 9;' }]))
      .toThrow(ReplacementFailed);
    expect(() => applyReplacements('f.ts', file, [{ old: 'const a = 1;', new: 'x' }]))
      .toThrow(/appears more than once/u);
  });

  it('changes every occurrence when asked explicitly', () => {
    const out = applyReplacements('f.ts', file, [{ old: 'const a = 1;', new: 'const a = 9;', all: true }]);
    expect(out).toBe('const a = 9;\nconst b = 2;\nconst a = 9;\n');
  });

  it('says the file is not what was expected when the text is absent', () => {
    expect(() => applyReplacements('f.ts', file, [{ old: 'nope', new: 'x' }]))
      .toThrow(/No occurrence of that text/u);
  });

  it('applies several fragments in order', () => {
    const out = applyReplacements('f.ts', 'one two\n', [
      { old: 'one', new: 'first' },
      { old: 'two', new: 'second' }
    ]);
    expect(out).toBe('first second\n');
  });

  it('never silently drops the rest of the file', () => {
    // The whole point: what lands is the real file with a bounded change, so
    // an agent that sends only a fragment cannot truncate anything.
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const out = applyReplacements('big.ts', big, [{ old: 'line 250', new: 'line 250 // edited' }]);
    expect(out.split('\n')).toHaveLength(500);
    expect(out).toContain('line 499');
  });
});
