// Structure health: a pure, provider-independent analysis over an accessibility
// tree that surfaces heading defects a rendered screenshot hides — the
// "title-on-title-on-title" nesting, empty or duplicated headings and skipped
// heading levels that models reproduce without noticing. Extraction (the tree)
// and judgement (these findings) are separate steps; this module is the
// judgement step, computed once where the tree is produced so every evidence
// path carries the same signal.

export type StructureFindingKind =
  | 'stacked_headings'
  | 'duplicate_heading'
  | 'empty_heading'
  | 'heading_level_skip';

export interface StructureFinding {
  kind: StructureFindingKind;
  message: string;
  headingText: string;
  level?: number;
  previousHeadingText?: string;
  previousLevel?: number;
}

export interface StructureHealth {
  headingCount: number;
  findingCount: number;
  findings: StructureFinding[];
  countsByKind: Record<StructureFindingKind, number>;
  clean: boolean;
  // True when traversal hit the node budget and stopped early, so the absence
  // of a finding beyond that point is unproven rather than confirmed clean.
  truncated: boolean;
}

interface AxNode {
  role?: unknown;
  name?: unknown;
  level?: unknown;
  children?: unknown;
}

// Roles whose presence between two headings means the first heading actually
// introduces content, so the pair is not a bare title stack.
const CONTENT_ROLES = new Set([
  'paragraph',
  'text',
  'statictext',
  'link',
  'button',
  'listitem',
  'list',
  'img',
  'image',
  'figure',
  'table',
  'cell',
  'article',
  'blockquote',
  'code',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'menuitem',
  'tab',
  'separator',
  'banner',
  'contentinfo'
]);

// Purely structural wrappers never count as content on their own — only their
// descendants do.
const CONTAINER_ROLES = new Set([
  'generic',
  'none',
  'presentation',
  'group',
  'section',
  'main',
  'navigation',
  'region',
  'document',
  'rootwebarea',
  'webarea',
  'landmark',
  'div',
  '',
  'ignored'
]);

const MAX_NODES = 20_000;

function roleOf(node: AxNode): string {
  return typeof node.role === 'string' ? node.role.toLowerCase() : '';
}

function nameOf(node: AxNode): string {
  return typeof node.name === 'string' ? node.name.replace(/\s+/g, ' ').trim() : '';
}

function levelOf(node: AxNode): number | undefined {
  if (typeof node.level === 'number' && Number.isFinite(node.level)) return node.level;
  return undefined;
}

function childrenOf(node: AxNode): AxNode[] {
  return Array.isArray(node.children) ? (node.children as AxNode[]) : [];
}

// One heading occurrence in reading order, tagged with how many meaningful
// content nodes had been seen when it was encountered. Two headings with the
// same `contentBefore` count had nothing between them.
interface HeadingHit {
  text: string;
  level?: number;
  contentBefore: number;
}

function normalize(text: string): string {
  return text.toLowerCase();
}

function isNested(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return true;
  return x.includes(y) || y.includes(x);
}

export function analyzeStructureHealth(tree: unknown): StructureHealth {
  const headings: HeadingHit[] = [];
  let contentSeen = 0;
  let visited = 0;
  let truncated = false;

  const roots: AxNode[] = Array.isArray(tree)
    ? (tree as AxNode[])
    : tree && typeof tree === 'object'
      ? [tree as AxNode]
      : [];

  const stack: AxNode[] = [...roots].reverse();
  while (stack.length > 0) {
    if (visited >= MAX_NODES) {
      truncated = true;
      break;
    }
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    visited += 1;
    const role = roleOf(node);
    if (role === 'heading') {
      headings.push({ text: nameOf(node), level: levelOf(node), contentBefore: contentSeen });
    } else if (CONTENT_ROLES.has(role) || (nameOf(node) !== '' && !CONTAINER_ROLES.has(role))) {
      contentSeen += 1;
    }
    const kids = childrenOf(node);
    for (let index = kids.length - 1; index >= 0; index -= 1) {
      const kid = kids[index];
      if (kid) stack.push(kid);
    }
  }

  const findings: StructureFinding[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    if (!current) continue;
    const previous = index > 0 ? headings[index - 1] : undefined;

    if (current.text === '') {
      findings.push({
        kind: 'empty_heading',
        message: 'Heading has no accessible text, so it adds structure with no content.',
        headingText: current.text,
        level: current.level
      });
    }

    if (previous) {
      const adjacent = current.contentBefore === previous.contentBefore;
      if (adjacent) {
        findings.push({
          kind: 'stacked_headings',
          message: 'Heading directly follows another heading with no content between them (title-on-title).',
          headingText: current.text,
          level: current.level,
          previousHeadingText: previous.text,
          previousLevel: previous.level
        });
      }
      if (current.text !== '' && previous.text !== '' && isNested(current.text, previous.text)) {
        findings.push({
          kind: 'duplicate_heading',
          message: 'Heading restates the heading above it, adding no unique information.',
          headingText: current.text,
          level: current.level,
          previousHeadingText: previous.text,
          previousLevel: previous.level
        });
      }
      if (
        current.level !== undefined &&
        previous.level !== undefined &&
        current.level - previous.level > 1
      ) {
        findings.push({
          kind: 'heading_level_skip',
          message: `Heading level jumps from ${previous.level} to ${current.level}, skipping a level.`,
          headingText: current.text,
          level: current.level,
          previousHeadingText: previous.text,
          previousLevel: previous.level
        });
      }
    }
  }

  const countsByKind: Record<StructureFindingKind, number> = {
    stacked_headings: 0,
    duplicate_heading: 0,
    empty_heading: 0,
    heading_level_skip: 0
  };
  for (const finding of findings) countsByKind[finding.kind] += 1;

  return {
    headingCount: headings.length,
    findingCount: findings.length,
    findings,
    countsByKind,
    clean: findings.length === 0,
    truncated
  };
}
