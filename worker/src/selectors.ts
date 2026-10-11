import { ForgeError } from './errors';
import { requirePath, sourceRange, type SourceRange } from './evidence';
import { inspectStructure, selectJson, selectSymbol } from './structure';

/** Selectors returned in evidence can be passed directly back to forge_read paths. */
export type Selector = { path: string; selection?: { kind: 'symbol' | 'id' | 'pointer'; value: string }; lines?: [number, number] };
export function parseSelector(input: string): Selector {
  const marker = input.indexOf('::');
  if (marker !== -1) {
    const path = requirePath(input.slice(0, marker));
    const rest = input.slice(marker + 2);
    const match = /^(symbol|id|pointer):(.*)$/s.exec(rest);
    if (!match || (match[1] !== 'pointer' && !match[2])) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Use path::symbol:Name, path::id:ID or path::pointer:/key. Selectors do not execute scripts.' });
    return { path, selection: { kind: match[1] as 'symbol' | 'id' | 'pointer', value: match[2]! } };
  }
  const lines = /^(.*):(\d+)-(\d+)$/.exec(input);
  if (lines) {
    const start = Number(lines[2]);
    const end = Number(lines[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Invalid line selector.' });
    return { path: requirePath(lines[1]!), lines: [start, end] };
  }
  return { path: requirePath(input) };
}
export function selectSource(selector: Selector, text: string): { text: string; range: SourceRange; representation: 'body' | 'record' } {
  if (selector.selection) {
    const selected = selector.selection.kind === 'symbol'
      ? selectSymbol(selector.path, text, selector.selection.value)
      : selectJson(selector.path, text, selector.selection.kind === 'id' ? { id: selector.selection.value } : { pointer: selector.selection.value });
    return { text: selected.text, range: selected.range, representation: selected.kind === 'json-record' ? 'record' : 'body' };
  }
  if (!selector.lines) return { text, range: sourceRange(text, 0, text.length), representation: 'body' };
  const [startLine, endLine] = selector.lines;
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  if (startLine > starts.length || endLine > starts.length) throw new ForgeError({ code: 'FORGE_NOT_FOUND', message: 'The requested lines exceed this source revision.' });
  const start = starts[startLine - 1]!;
  const end = starts[endLine] ?? text.length;
  return { text: text.slice(start, end), range: sourceRange(text, start, end), representation: 'body' };
}
export function outline(path: string, text: string): string {
  const structure = inspectStructure(path, text);
  if (!structure.supported) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: structure.limitation! });
  if (structure.diagnostics.length) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Cannot construct a valid outline from source with parser errors.' });
  return structure.blocks.map((block) => `${path}::symbol:${block.name} [${block.range.startLine}-${block.range.endLine}]\n${block.signature}`).join('\n\n');
}
