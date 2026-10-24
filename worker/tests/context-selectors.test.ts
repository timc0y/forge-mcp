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
  it('ends continuation at the last physical line, including newline-terminated files', () => {
    for (const newline of ['\n', '\r\n']) {
      const source = `header${newline}one${newline}two${newline}`;
      const first = selectSource(parseSelector('ledger.csv:1-2'), source);
      expect(first.totalLines).toBe(3);
      expect(first.next).toBe('ledger.csv:3-3');
      const last = selectSource(parseSelector(first.next!), source);
      expect(last.text).toBe(`two${newline}`);
      expect(last.next).toBeUndefined();
      expect(first.text + last.text).toBe(source);
      expect(() => selectSource(parseSelector('ledger.csv:4-4'), source)).toThrow(/exceed/);
    }
    const blankLine = selectSource(parseSelector('a.txt:1-1'), '\n');
    expect(blankLine.text).toBe('\n');
    expect(blankLine.next).toBeUndefined();
    expect(selectSource(parseSelector('a.txt:1-1'), '').text).toBe('');
  });
  it('selects a full ledger record and rejects duplicate IDs', () => {
    const source = '{"issues":[{"id":"SR-1","action":"keep"},{"id":"SR-755","action":"test"}]}';
    expect(selectJson('issues.json', source, { id: 'SR-755' }).text).toBe('{"id":"SR-755","action":"test"}');
    expect(() => selectJson('issues.json', '{"a":{"id":"same"},"b":{"id":"same"}}', { id: 'same' })).toThrow(/2 objects/);
  });
  it.each(['first\nsecond\n', 'first\r\nsecond\r\n', ''])('refuses out-of-range reads with known line count and a valid recovery selector', (source) => {
    let failure: any;
    try { selectSource(parseSelector('notes.txt:36-99'), source); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'FORGE_NOT_FOUND', details: { totalLines: source ? 2 : 1, requestedLines: [36, 99] } });
    expect(failure.message).toContain('exact request was not shortened');
    expect(() => selectSource(parseSelector(failure.details.suggestedSelector), source)).not.toThrow();
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
