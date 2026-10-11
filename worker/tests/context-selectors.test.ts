import { describe, expect, it } from 'vitest';
import { inspectStructure, selectJson, selectSymbol, validateSource } from '../src/structure';
import { parseSelector, selectSource } from '../src/selectors';

describe('exact structured source selection', () => {
  it('reads a complete failure path and retains its finally block', () => {
    const source = 'export function build() { try { return run(); } finally { restore(); } }\nfunction other() {}';
    expect(selectSymbol('a.ts', source, 'build').text).toBe(source.split('\n')[0]);
  });
  it('uses scope and refuses duplicate symbol identities', () => {
    const source = 'class A { run() { return 1; } }\nclass B { run() { return 2; } }';
    expect(selectSymbol('a.ts', source, 'A/run').text).toContain('return 1');
    expect(() => selectSymbol('a.ts', 'function f() {}\nfunction f() {}', 'f')).toThrow(/2 declarations/);
  });
  it('preserves Unicode and CRLF byte-for-byte', () => {
    const source = '// 😀\r\nexport function hello() { return "é"; }\r\n';
    expect(selectSource(parseSelector('a.ts:2-2'), source).text).toBe('export function hello() { return "é"; }\r\n');
    const symbol = selectSymbol('a.ts', source, 'hello');
    expect(source.slice(symbol.range.start, symbol.range.end)).toBe(symbol.text);
  });
  it('selects a full ledger record and rejects duplicate IDs', () => {
    const source = '{"issues":[{"id":"SR-1","action":"keep"},{"id":"SR-755","action":"test"}]}';
    expect(selectJson('issues.json', source, { id: 'SR-755' }).text).toBe('{"id":"SR-755","action":"test"}');
    expect(() => selectJson('issues.json', '{"a":{"id":"same"},"b":{"id":"same"}}', { id: 'same' })).toThrow(/2 objects/);
  });
  it('understands escaped JSON pointers without executing queries', () => {
    expect(selectJson('a.json', '{"a/b":{"~x":4}}', { pointer: '/a~1b/~0x' }).text).toBe('4');
    expect(() => selectJson('a.json', '{}', { pointer: '/~2' })).toThrow(/escape/);
  });
  it('distinguishes strict JSON from configured JSONC and rejects duplicate keys', () => {
    expect(() => validateSource('package.json', '{/*comment*/"a":1}')).toThrow();
    expect(validateSource('tsconfig.json', '{/*comment*/"compilerOptions":{}}').supported).toBe(true);
    expect(() => selectJson('a.jsonc', '{"a":1,"a":2}', { pointer: '/a' })).toThrow(/duplicate/);
  });
  it('reports unsupported formats instead of regex declarations', () => {
    expect(inspectStructure('a.py', 'def thing(): pass').supported).toBe(false);
    expect(() => selectSymbol('a.astro', '---\nconst x=1\n---', 'x')).toThrow(/unsupported/);
  });
  it('records imports as syntax, not inferred reachability', () => {
    const shape = inspectStructure('a.ts', 'import { x as y } from "./b"; export { z } from "./c"; import("./d");');
    expect(shape.imports.map((edge) => edge.specifier)).toEqual(['./b', './c', './d']);
    expect(shape.limitation).toContain('not type-resolved');
  });
});
