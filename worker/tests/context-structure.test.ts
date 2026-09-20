import { describe, expect, it } from 'vitest';
import { inspectStructure, selectSymbol, validateSource } from '../src/structure';

describe('compact structural representations', () => {
  it('keeps class signatures compact while retaining precise method bodies', () => {
    const source = 'export class Example extends Base {\n  run(value: string) { return value.trim(); }\n  stop() { return false; }\n}\n';
    const shape = inspectStructure('a.ts', source);
    const klass = shape.blocks.find((block) => block.name === 'Example')!;
    const method = shape.blocks.find((block) => block.name === 'Example/run')!;
    expect(klass.signature).toBe('export class Example extends Base { … }');
    expect(klass.signature).not.toContain('return value');
    expect(method.text).toContain('return value.trim()');
    expect(selectSymbol('a.ts', source, 'Example/run').text).toBe(method.text);
  });

  it('keeps arrow-function outlines smaller than their implementations', () => {
    const source = 'export const calculate = (value: number) => {\n  const doubled = value * 2;\n  return doubled;\n};\n';
    const block = inspectStructure('a.ts', source).blocks.find((entry) => entry.name === 'calculate')!;
    expect(block.signature).toContain('export const calculate = (value: number) =>');
    expect(block.signature).not.toContain('const doubled');
  });

  it('sections Markdown without treating fenced headings as structure', () => {
    const source = '# Root\nkeep\n\n## Safety\nimportant\n\n\`\`\`md\n# fake\n\`\`\`\n\n## Operations\nrun\n';
    const shape = inspectStructure('AGENTS.md', source);
    expect(shape.blocks.map((block) => block.name)).toEqual(['Root', 'Root/Safety', 'Root/Operations']);
    expect(selectSymbol('AGENTS.md', source, 'Root/Safety').text).toContain('important');
  });

  it('validates YAML with the admitted parser', () => {
    expect(validateSource('config.yml', 'enabled: true\n').supported).toBe(true);
    expect(() => validateSource('config.yml', 'a: [\n')).toThrow(/parser errors/);
  });
});
