import { TOKEN_ESTIMATOR, estimatedTokens, utf8Bytes, type Evidence } from './evidence';

export interface PackedEvidence { items: Evidence[]; omitted: Array<{ selector: string; reason: string }>; bytes: number; estimatedTokens: number; estimator: string; missingMandatory: boolean }
export function evidenceCovered(candidate: Evidence, items: readonly Evidence[]): boolean {
  return items.some((item) => item.source.sha === candidate.source.sha && item.path === candidate.path && item.representation === 'body' && ((item.selector === candidate.selector && item.text === candidate.text) || (item.range && candidate.range && item.range.start <= candidate.range.start && item.range.end >= candidate.range.end)));
}
/** Complete extractive blocks only. No line slicing, paraphrasing or arbitrary token deletion. */
export function packEvidence(candidates: readonly Evidence[], byteBudget: number): PackedEvidence {
  const items: Evidence[] = [];
  const omitted = new Map<string, PackedEvidence['omitted'][number]>();
  const remaining = [...candidates];
  const categories = new Set<string>();
  let bytes = 0;
  const cost = ({ source: _source, ...item }: Evidence): number => utf8Bytes(JSON.stringify(item)) + 2;
  const append = (item: Evidence): void => {
    if (evidenceCovered(item, items)) return;
    const size = cost(item);
    // A complete parent replaces its children; charging both can reject source that fits.
    const replaced = new Set(items.filter((existing) => evidenceCovered(existing, [item])));
    const replacedBytes = [...replaced].reduce((total, existing) => total + cost(existing), 0);
    if (bytes + size - replacedBytes > byteBudget) {
      omitted.set(item.selector, { selector: item.selector, reason: 'Complete block exceeds remaining output budget.' });
      return;
    }
    if (replaced.size) {
      for (let index = items.length - 1; index >= 0; index--) if (replaced.has(items[index]!)) items.splice(index, 1);
      categories.clear();
      for (const retained of items) categories.add(retained.category);
    }
    items.push(item);
    bytes += size - replacedBytes;
    categories.add(item.category);
  };
  const mandatory = remaining.filter((item) => item.mandatory);
  for (let index = remaining.length - 1; index >= 0; index--) if (remaining[index]!.mandatory) remaining.splice(index, 1);
  const containers = remaining.filter((item) => mandatory.some((required) => evidenceCovered(required, [item])))
    .sort((a, b) => cost(a) - cost(b) || a.id.localeCompare(b.id));
  const coverageCandidates = [...mandatory, ...containers];
  // A containing body can make required source fit. Resolve that coverage before unrelated text.
  // Each pass must cover another original block, and freed space goes to requirements first.
  const packMandatory = (): void => {
    let previousCoverage = -1;
    for (;;) {
      const covered = coverageCandidates.filter((item) => evidenceCovered(item, items)).length;
      if (covered <= previousCoverage) break;
      previousCoverage = covered;
      for (const item of mandatory) append(item);
      for (const parent of containers) {
        if (evidenceCovered(parent, items)) continue;
        const suppliesMissing = mandatory.some((item) => !evidenceCovered(item, items) && evidenceCovered(item, [parent]));
        const replacedBytes = items.reduce((total, item) => total + (evidenceCovered(item, [parent]) ? cost(item) : 0), 0);
        if (!suppliesMissing && replacedBytes <= cost(parent)) continue;
        append(parent);
        if (evidenceCovered(parent, items)) break;
      }
    }
  };
  packMandatory();
  while (remaining.length) {
    remaining.sort((a, b) => {
      const utility = (item: Evidence): number => ((item.relevance ?? 0) + (categories.has(item.category) ? 0 : 0.3) + (item.counterEvidence ?? 0)) / Math.max(1, cost(item));
      return utility(b) - utility(a) || a.id.localeCompare(b.id);
    });
    const before = bytes;
    append(remaining.shift()!);
    if (bytes < before) packMandatory();
  }
  // A later containing block may satisfy an earlier block that did not fit.
  const missingMandatory = candidates.some((item) => item.mandatory && !evidenceCovered(item, items));
  return { items, omitted: [...omitted.values()].filter((entry) => !candidates.some((item) => item.selector === entry.selector && evidenceCovered(item, items))), bytes, estimatedTokens: estimatedTokens(items.map((item) => item.text).join('\n')), estimator: TOKEN_ESTIMATOR, missingMandatory };
}
