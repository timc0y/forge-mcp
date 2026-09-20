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

  it('makes duplicate symbols and Markdown headings individually addressable', () => {
    const code = 'function f() {}\nfunction f() {}\n';
    expect(inspectStructure('a.ts', code).blocks.map((block) => block.name)).toEqual(['f[0]', 'f[1]']);
    expect(selectSymbol('a.ts', code, 'f[1]').text).toBe('function f() {}');
    const markdown = '# Root\n## Same\none\n## Same\ntwo\n';
    expect(inspectStructure('a.md', markdown).blocks.map((block) => block.name)).toEqual(['Root', 'Root/Same', 'Root/Same[2]']);
    expect(selectSymbol('a.md', markdown, 'Root/Same[2]').text).toContain('two');
  });

  it('uses Shopify\'s strict parser for Liquid and exposes exact nested blocks', () => {
    const source = '{% if product %}<div>{{ product.title }}</div>{% endif %}';
    const shape = inspectStructure('section.liquid', source);
    expect(shape.supported).toBe(true);
    expect(shape.parser).toContain('@shopify/liquid-html-parser/2.10.0');
    const tag = shape.blocks.find((block) => block.name.includes('LiquidTag:if'))!;
    expect(tag.text).toBe(source);
    expect(shape.blocks.some((block) => block.name.includes('HtmlElement'))).toBe(true);
  });
});
