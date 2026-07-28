/**
 * Apply an agent's fragment edits to the file's current content.
 *
 * Whole-file writes are the expensive and dangerous way to change one line: an
 * agent has to re-emit the entire file, which costs output tokens it may not
 * have, and a truncated re-emission passes every check we have — it read the
 * file, so the read-guard is satisfied, and Forge commits the truncation.
 *
 * Sending only the fragment removes both problems. Forge does the reading, so
 * the content that lands is the real file with a bounded change applied, and
 * nothing the agent omits can be lost.
 */
export class ReplacementFailed extends Error {
  readonly path: string;
  readonly reason: 'not_found' | 'ambiguous';
  constructor(path: string, reason: 'not_found' | 'ambiguous', snippet: string) {
    const preview = snippet.length > 120 ? `${snippet.slice(0, 120)}…` : snippet;
    super(
      reason === 'not_found'
        ? `No occurrence of that text in ${path}: ${JSON.stringify(preview)}. Read the file again — it is not what you expected.`
        : `That text appears more than once in ${path}: ${JSON.stringify(preview)}. Include enough surrounding context to identify one occurrence, or set all:true to change every one.`
    );
    this.name = 'ReplacementFailed';
    this.path = path;
    this.reason = reason;
  }
}

export function applyReplacements(
  path: string,
  current: string,
  replacements: Array<{ old: string; new: string; all?: boolean }>
): string {
  let next = current;
  for (const replacement of replacements) {
    const first = next.indexOf(replacement.old);
    if (first === -1) throw new ReplacementFailed(path, 'not_found', replacement.old);
    if (replacement.all) {
      next = next.split(replacement.old).join(replacement.new);
      continue;
    }
    // Ambiguity is refused rather than resolved: picking the first match would
    // silently edit a line the agent never meant.
    if (next.indexOf(replacement.old, first + replacement.old.length) !== -1) {
      throw new ReplacementFailed(path, 'ambiguous', replacement.old);
    }
    next = `${next.slice(0, first)}${replacement.new}${next.slice(first + replacement.old.length)}`;
  }
  return next;
}
