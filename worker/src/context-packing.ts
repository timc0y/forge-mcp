import { TOKEN_ESTIMATOR, estimatedTokens, utf8Bytes, type Evidence } from './evidence';

export interface PackedEvidence { items: Evidence[]; omitted: Array<{ selector: string; reason: string }>; bytes: number; estimatedTokens: number; estimator: string; missingMandatory: boolean }
/** Complete extractive blocks only. No line slicing, paraphrasing or arbitrary token deletion. */
export function packEvidence(candidates: readonly Evidence[], byteBudget: number): PackedEvidence {
  const items: Evidence[] = [];
  const omitted: PackedEvidence['omitted'] = [];
  const remaining = [...candidates];
  const categories = new Set<string>();
  let bytes = 0;
  let missingMandatory = false;
  const cost = (item: Evidence): number => utf8Bytes(JSON.stringify({ id: item.id, path: item.path, selector: item.selector, range: item.range, text: item.text, kind: item.kind, representation: item.representation, category: item.category, coverage: item.coverage, provenance: item.provenance, limitations: item.limitations })) + 2;
  const covered = (candidate: Evidence): boolean => items.some((item) => item.source.sha === candidate.source.sha && item.path === candidate.path && item.representation === 'body' && item.range && candidate.range && item.range.start <= candidate.range.start && item.range.end >= candidate.range.end);
  const append = (item: Evidence): void => {
    if (covered(item)) { omitted.push({ selector: item.selector, reason: 'Already represented by a containing exact source block.' }); return; }
    const size = cost(item);
    if (bytes + size > byteBudget) {
      if (item.mandatory) missingMandatory = true;
      omitted.push({ selector: item.selector, reason: 'Complete block exceeds remaining output budget.' });
      return;
    }
    items.push(item);
    bytes += size;
    categories.add(item.category);
  };
  for (let index = remaining.length - 1; index >= 0; index--) {
    if (remaining[index]!.mandatory) append(remaining.splice(index, 1)[0]!);
  }
  while (remaining.length) {
    remaining.sort((a, b) => {
      const utility = (item: Evidence): number => ((item.relevance ?? 0) + (categories.has(item.category) ? 0 : 0.3) + (item.counterEvidence ?? 0)) / Math.max(1, cost(item));
      return utility(b) - utility(a) || a.id.localeCompare(b.id);
    });
    append(remaining.shift()!);
  }
  return { items, omitted, bytes, estimatedTokens: estimatedTokens(items.map((item) => item.text).join('\n')), estimator: TOKEN_ESTIMATOR, missingMandatory };
}
