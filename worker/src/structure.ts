import ts from 'typescript';
import { parser as markdownParser } from '@lezer/markdown';
import { NodeTypes, toLiquidHtmlAST, type LiquidHtmlNode } from '@shopify/liquid-html-parser';
import { parseDocument } from 'yaml';
import { ForgeError } from './errors';
import { CONTEXT_LIMITS, sourceRange, utf8Bytes, type SourceRange } from './evidence';

export interface SourceBlock { name: string; kind: string; range: SourceRange; signature: string; text: string }
export interface LiteralImport { specifier: string; range: SourceRange; kind: 'import' | 'export' | 'dynamic-import' }
export interface Structure {
  supported: boolean;
  parser: string;
  blocks: SourceBlock[];
  imports: LiteralImport[];
  diagnostics: Array<{ line: number; message: string }>;
  limitation?: string;
}
export const STRUCTURE_VERSION = `typescript/${ts.version}:parse-only-v1`;
const scriptExtensions = /\.(?:[cm]?[jt]sx?)$/i;
const markdownExtensions = /\.(?:md|mdx)$/i;
const yamlExtensions = /\.ya?ml$/i;
const liquidExtensions = /\.liquid$/i;
export const isJsonSource = (path: string): boolean => /\.jsonc?$/i.test(path);
export const allowsJsonComments = (path: string): boolean => /\.jsonc$/i.test(path) || /(?:^|\/)(?:tsconfig(?:\.[^.]+)?|jsconfig|knip)\.json$/i.test(path) || /(?:^|\/)\.vscode\/(?:settings|extensions|launch|tasks)\.json$/i.test(path);

function diagnostics(file: ts.SourceFile): Structure['diagnostics'] {
  // Parser diagnostics are produced by createSourceFile/parseJsonText, never a compiler program.
  const errors = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  return errors.map((error) => ({
    line: file.getLineAndCharacterOfPosition(error.start ?? 0).line + 1,
    message: ts.flattenDiagnosticMessageText(error.messageText, '\n')
  }));
}
function sourceKind(path: string): ts.ScriptKind {
  return /\.tsx$/i.test(path) ? ts.ScriptKind.TSX : /\.jsx$/i.test(path) ? ts.ScriptKind.JSX : /\.[cm]?js$/i.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}
function propertyName(node: ts.Node): string | null {
  const named = node as ts.NamedDeclaration;
  const name = named.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}
function assertParseSize(text: string): void {
  if (utf8Bytes(text) > CONTEXT_LIMITS.parseBytes) {
    throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: 'This source exceeds the parse-only size limit. Exact reads remain a separate capability.' });
  }
}
function compactSignature(node: ts.Node, file: ts.SourceFile, text: string, start: number, end: number): string {
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
    const brace = node.getChildren(file).find((child) => child.kind === ts.SyntaxKind.OpenBraceToken);
    const open = brace?.getStart(file) ?? -1;
    return open >= start && open < end ? `${text.slice(start, open).trimEnd()} { … }` : text.slice(start, end).trim();
  }
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return node.body ? text.slice(start, node.body.getStart(file)).trimEnd() : text.slice(start, end).trim();
  }
  if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
    const initializer = node.declarationList.declarations[0]!.initializer;
    if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
      return `${text.slice(start, initializer.body.getStart(file)).trimEnd()} …;`;
    }
  }
  return text.slice(start, end).trim();
}
function markdownHeadingTitle(raw: string, type: string): string {
  if (type.startsWith('ATXHeading')) return raw.replace(/^#{1,6}[ \t]+/, '').replace(/[ \t]+#+[ \t]*(?:\r?\n)?$/, '').trim();
  const lines = raw.trimEnd().split(/\r?\n/);
  return lines.slice(0, -1).join(' ').trim();
}
function markdownStructure(_path: string, text: string): Structure {
  assertParseSize(text);
  const tree = markdownParser.parse(text);
  const headings: Array<{ level: number; title: string; start: number }> = [];
  const cursor = tree.cursor();
  const visit = (): void => {
    const name = cursor.type.name;
    const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
    if (match) headings.push({ level: Number(match[1]), title: markdownHeadingTitle(text.slice(cursor.from, cursor.to), name), start: cursor.from });
    if (cursor.firstChild()) { do visit(); while (cursor.nextSibling()); cursor.parent(); }
  };
  visit();
  headings.sort((a, b) => a.start - b.start);
  const blocks: SourceBlock[] = [];
  const stack: Array<{ level: number; segment: string }> = [];
  const siblings = new Map<string, number>();
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]!;
    while (stack.length && stack.at(-1)!.level >= heading.level) stack.pop();
    const parent = stack.map((entry) => entry.segment).join('/');
    const siblingKey = `${parent}\0${heading.title}`;
    const occurrence = (siblings.get(siblingKey) ?? 0) + 1;
    siblings.set(siblingKey, occurrence);
    const segment = occurrence === 1 ? heading.title : `${heading.title}[${occurrence}]`;
    const name = [parent, segment].filter(Boolean).join('/');
    let end = text.length;
    for (let next = index + 1; next < headings.length; next++) if (headings[next]!.level <= heading.level) { end = headings[next]!.start; break; }
    const range = sourceRange(text, heading.start, end);
    blocks.push({ name, kind: 'MarkdownSection', range, signature: `${'#'.repeat(heading.level)} ${heading.title}`, text: text.slice(range.start, range.end) });
    stack.push({ level: heading.level, segment });
  }
  if (!blocks.length && text.trim()) blocks.push({ name: '(document)', kind: 'MarkdownDocument', range: sourceRange(text, 0, text.length), signature: '(document)', text });
  return { supported: true, parser: '@lezer/markdown/1.6.3:sections-v1', blocks, imports: [], diagnostics: [], limitation: 'CommonMark syntax tree with heading-delimited section ranges; inline Markdown is parsed but only section structure is returned.' };
}
function yamlStructure(text: string): Structure {
  assertParseSize(text);
  const document = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
  return { supported: true, parser: 'yaml/2.9.0:document-v1', blocks: [], imports: [], diagnostics: document.errors.map((error) => ({ line: 1, message: error.message })), limitation: 'YAML validation only; no runtime schema is inferred.' };
}
function liquidLabel(node: LiquidHtmlNode, sibling: number): string {
  const value = node as LiquidHtmlNode & { name?: unknown };
  const name = typeof value.name === 'string' ? value.name : '';
  return `${node.type}${name ? `:${name}` : ''}[${sibling}]`;
}
function liquidStructure(text: string): Structure {
  assertParseSize(text);
  let root: LiquidHtmlNode;
  try { root = toLiquidHtmlAST(text); }
  catch (error) { return { supported: true, parser: '@shopify/liquid-html-parser/2.10.0:strict-v1', blocks: [], imports: [], diagnostics: [{ line: 1, message: error instanceof Error ? error.message : 'Liquid parse failed.' }] }; }
  const blocks: SourceBlock[] = [];
  const interesting = new Set<string>([
    NodeTypes.LiquidTag, NodeTypes.LiquidRawTag, NodeTypes.HtmlElement,
    NodeTypes.HtmlSelfClosingElement, NodeTypes.HtmlVoidElement, NodeTypes.YAMLFrontmatter
  ]);
  const walk = (node: LiquidHtmlNode, parent = '', sibling = 0): void => {
    const anyNode = node as LiquidHtmlNode & { position?: { start: number; end: number }; children?: LiquidHtmlNode[] };
    const label = liquidLabel(node, sibling);
    const name = parent ? `${parent}/${label}` : label;
    const position = anyNode.position;
    if (interesting.has(node.type) && position && Number.isSafeInteger(position.start) && Number.isSafeInteger(position.end) && position.start >= 0 && position.end >= position.start && position.end <= text.length) {
      const range = sourceRange(text, position.start, position.end);
      const body = text.slice(range.start, range.end);
      const opening = body.split(/\r?\n/, 1)[0]!.slice(0, 300);
      blocks.push({ name, kind: node.type, range, signature: opening, text: body });
    }
    const children = Array.isArray(anyNode.children) ? anyNode.children : [];
    children.forEach((child, index) => walk(child, name, index));
  };
  walk(root);
  return { supported: true, parser: '@shopify/liquid-html-parser/2.10.0:strict-v1', blocks, imports: [], diagnostics: [], limitation: 'Liquid/HTML syntax tree only; Shopify render/section relationships are not resolved as module imports.' };
}
export function inspectStructure(path: string, text: string): Structure {
  if (markdownExtensions.test(path)) return markdownStructure(path, text);
  if (yamlExtensions.test(path)) return yamlStructure(text);
  if (liquidExtensions.test(path)) return liquidStructure(text);
  if (!scriptExtensions.test(path) && !isJsonSource(path)) {
    return { supported: false, parser: 'none', blocks: [], imports: [], diagnostics: [], limitation: 'No admitted parser for this format; no regex structure was substituted.' };
  }
  if (isJsonSource(path)) {
    const file = jsonTree(path, text);
    const errors = diagnostics(file);
    try { if (!allowsJsonComments(path)) JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { errors.push({ line: 1, message: 'Invalid strict JSON.' }); }
    duplicateKeys(file, errors);
    return { supported: true, parser: STRUCTURE_VERSION, blocks: [], imports: [], diagnostics: errors };
  }
  assertParseSize(text);
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, sourceKind(path));
  const errors = diagnostics(file);
  const blocks: SourceBlock[] = [];
  const imports: LiteralImport[] = [];
  if (errors.length) return { supported: true, parser: STRUCTURE_VERSION, blocks, imports, diagnostics: errors };
  const add = (node: ts.Node, name: string): void => {
    const start = node.getStart(file, true);
    const end = node.getEnd();
    blocks.push({ name, kind: ts.SyntaxKind[node.kind]!, range: sourceRange(text, start, end), text: text.slice(start, end), signature: compactSignature(node, file, text, start, end) });
  };
  const walk = (node: ts.Node, parent = ''): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({ specifier: node.moduleSpecifier.text, range: sourceRange(text, node.getStart(file), node.getEnd()), kind: ts.isImportDeclaration(node) ? 'import' : 'export' });
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) {
      imports.push({ specifier: node.arguments[0]!.text, range: sourceRange(text, node.getStart(file), node.getEnd()), kind: 'dynamic-import' });
    }
    const name = propertyName(node);
    const declaration = ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node);
    let scope = parent;
    if (declaration && name) {
      scope = parent ? `${parent}/${name}` : name;
      add(node, scope);
    } else if (ts.isVariableStatement(node)) {
      const names = node.declarationList.declarations.map(propertyName).filter((value): value is string => value !== null);
      if (names.length === 1) add(node, parent ? `${parent}/${names[0]}` : names[0]!);
    } else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const callee = call.expression.getText(file);
      const first = call.arguments[0];
      if (/^(?:test|it|describe)(?:\.(?:only|skip|todo))?$/.test(callee) && first && ts.isStringLiteralLike(first)) add(node, `${callee}:${first.text}`);
    }
    ts.forEachChild(node, (child) => walk(child, scope));
  };
  walk(file);
  const totals = new Map<string, number>();
  for (const block of blocks) totals.set(block.name, (totals.get(block.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const block of blocks) {
    if ((totals.get(block.name) ?? 0) < 2) continue;
    const index = seen.get(block.name) ?? 0;
    seen.set(block.name, index + 1);
    block.name = `${block.name}[${index}]`;
  }
  return { supported: true, parser: STRUCTURE_VERSION, blocks, imports, diagnostics: errors, limitation: 'Syntax declarations and literal imports only; not type-resolved references or runtime reachability.' };
}
function jsonTree(path: string, text: string): ts.JsonSourceFile {
  if (utf8Bytes(text) > CONTEXT_LIMITS.sourceBytes) throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: 'JSON source exceeds its parser byte limit.' });
  return ts.parseJsonText(path, text);
}
function duplicateKeys(file: ts.JsonSourceFile, errors: Structure['diagnostics']): void {
  const walk = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set<string>();
      for (const property of node.properties) {
        const name = propertyName(property);
        if (name !== null) {
          if (seen.has(name)) errors.push({ line: file.getLineAndCharacterOfPosition(property.getStart(file)).line + 1, message: 'Duplicate JSON object key.' });
          seen.add(name);
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
}
export function validateSource(path: string, text: string): Structure {
  const structure = inspectStructure(path, text);
  if (structure.diagnostics.length) {
    throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: `${path} has parser errors at line ${structure.diagnostics[0]!.line}. No source was written.`, details: { path, diagnostics: structure.diagnostics } });
  }
  return structure;
}
export function selectSymbol(path: string, text: string, name: string): SourceBlock {
  const structure = validateSource(path, text);
  if (!structure.supported || isJsonSource(path) || yamlExtensions.test(path)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Symbol selection is unsupported for this format.' });
  const matches = structure.blocks.filter((block) => block.name === name);
  if (matches.length !== 1) throw new ForgeError({ code: matches.length ? 'FORGE_AMBIGUOUS' : 'FORGE_NOT_FOUND', message: `Symbol selector matched ${matches.length} declarations. Use an exact name from the outline; no first match was chosen.` });
  return matches[0]!;
}
export function selectJson(path: string, text: string, selector: { pointer: string } | { id: string }): SourceBlock {
  if (!isJsonSource(path)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Record selection requires a JSON or JSONC source.' });
  // Ledgers may be larger than code; bound the input before parsing, not after allocation.
  if (utf8Bytes(text) > CONTEXT_LIMITS.sourceBytes) throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: 'JSON source exceeds its record-selection budget.' });
  if (!allowsJsonComments(path)) {
    try { JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Invalid strict JSON.' }); }
  }
  const file = ts.parseJsonText(path, text);
  const errors = diagnostics(file);
  duplicateKeys(file, errors);
  if (errors.length) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'JSON source has syntax errors or duplicate keys.' });
  const first = file.statements[0];
  if (!first || !ts.isExpressionStatement(first)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'No JSON root value was found.' });
  let target: ts.Node = first.expression;
  if ('pointer' in selector) {
    if (selector.pointer !== '' && !selector.pointer.startsWith('/')) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'JSON pointers must start with /.' });
    for (const part of selector.pointer === '' ? [] : selector.pointer.slice(1).split('/')) {
      if (/~(?:[^01]|$)/.test(part)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Invalid JSON pointer escape.' });
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      let next: ts.Node | undefined;
      if (ts.isObjectLiteralExpression(target)) {
        const property = target.properties.find((property) => propertyName(property) === key);
        if (property && ts.isPropertyAssignment(property)) next = property.initializer;
      } else if (ts.isArrayLiteralExpression(target) && /^(?:0|[1-9]\d*)$/.test(key)) next = target.elements[Number(key)];
      if (!next) throw new ForgeError({ code: 'FORGE_NOT_FOUND', message: 'The JSON pointer does not identify a value.' });
      target = next;
    }
  } else {
    const matches: ts.ObjectLiteralExpression[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node) && node.properties.some((property) => ts.isPropertyAssignment(property) && propertyName(property) === 'id' && ts.isStringLiteral(property.initializer) && property.initializer.text === selector.id)) matches.push(node);
      ts.forEachChild(node, walk);
    };
    walk(target);
    if (matches.length !== 1) throw new ForgeError({ code: matches.length ? 'FORGE_AMBIGUOUS' : 'FORGE_NOT_FOUND', message: `Record ID matched ${matches.length} objects. No first match was chosen.` });
    target = matches[0]!;
  }
  const range = sourceRange(text, target.getStart(file), target.getEnd());
  const selected = text.slice(range.start, range.end);
  return { name: 'pointer' in selector ? selector.pointer : selector.id, kind: 'json-record', range, text: selected, signature: selected };
}
