import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { forgeTools, REMOVED_TOOLS } from '@forge/mcp-core';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Prose an agent reads.
 *
 * Keyed forms (`next_step: '…'`) are the common case, but they are not the only
 * one, and keying on them alone left a hole this test existed to close:
 * branch-policy.ts wrote `next_step: onAgentBranch ? '…' : '…'`, and because a
 * ternary follows the colon rather than a quote, a live instruction to call the
 * long-removed forge_git_branch sat there unnoticed.
 *
 * So the sweep is now shape-independent: every string literal in the file that
 * reads like a sentence — it contains a space — counts as prose, wherever it
 * sits. An identifier like `name: 'forge_edit'` has no space and is skipped, so
 * ordinary code references stay out of it.
 */
function agentFacingStrings(source: string): string[] {
  const found: string[] = [];
  // Look at what FOLLOWS the key rather than requiring a quote to sit against
  // the colon, then take the prose-shaped literals out of that window. A
  // sentence has a space in it; `pull_requests: 'forge_pr_can_list_...'` and a
  // log event name do not, so ordinary code stays out of the sweep.
  for (const key of source.matchAll(/(?:message|next_step|hint|nextStep)\s*:/gu)) {
    const window = source.slice(key.index ?? 0, (key.index ?? 0) + 600);
    for (const literal of window.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*?)\1/gu)) {
      const text = literal[2] as string;
      if (text.includes(' ')) found.push(text);
    }
  }
  for (const match of source.matchAll(/allowedNextActions\s*:\s*\[([^\]]*)\]/gu)) {
    found.push(match[1] as string);
  }
  return found;
}

const ROOTS = ['packages', 'apps'].map((root) => join(process.cwd(), root));
const FILES = ROOTS.flatMap((root) => sourceFiles(root))
  // The removal map exists precisely to name removed tools.
  .filter((file) => !file.includes('removed-tools') && !file.endsWith('mcp-core/src/index.ts'));

describe('guidance an agent is told to follow', () => {
  it('never sends an agent to a tool that no longer exists', () => {
    // This regressed four separate times while the catalog shrank:
    // allowedNextActions, a recycled-workspace error, a patch failure, a
    // divergence message and the prompt templates all kept naming dead tools.
    // A human reading a diff will not catch the fifth; this will.
    const removed = new Set(Object.keys(REMOVED_TOOLS));
    const offences: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      for (const prose of agentFacingStrings(source)) {
        for (const named of prose.match(/forge_[a-z_]+/gu) ?? []) {
          if (removed.has(named)) offences.push(`${file.split('/').slice(-2).join('/')}: ${named}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('only ever names tools that are actually in the catalog', () => {
    const live = new Set(forgeTools.map((tool) => tool.name));
    const unknown: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      for (const prose of agentFacingStrings(source)) {
        for (const named of prose.match(/forge_[a-z_]+/gu) ?? []) {
          if (!live.has(named) && !(named in REMOVED_TOOLS)) unknown.push(`${file.split('/').slice(-2).join('/')}: ${named}`);
        }
      }
    }
    // A typo'd or invented tool name is the same dead end as a removed one.
    expect(unknown).toEqual([]);
  });
});
