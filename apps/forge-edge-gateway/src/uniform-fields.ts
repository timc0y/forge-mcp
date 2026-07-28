/**
 * State a repeated value once instead of on every row.
 *
 * A list response whose rows all carry the same field pays for that field N
 * times. forge_repository_list sent the same installation id and the same
 * verification timestamp on all 24 repositories — 1,800 bytes of two identical
 * strings, over half the response.
 *
 * Only hoists a key when *every* row agrees on it, so a differing value is
 * never flattened away into a claim that is wrong for some rows. Rows keep any
 * key that varies.
 */
export function hoistUniformFields<T extends Record<string, unknown>>(
  rows: readonly T[],
  keys: readonly string[]
): { rows: Array<Record<string, unknown>>; shared: Record<string, unknown> } {
  const shared: Record<string, unknown> = {};
  if (rows.length === 0) return { rows: [...rows], shared };

  const uniform = keys.filter((key) => {
    const first = rows[0]?.[key];
    if (first === undefined) return false;
    return rows.every((row) => row[key] === first);
  });
  if (uniform.length === 0) return { rows: [...rows], shared };

  for (const key of uniform) shared[key] = rows[0]?.[key];
  const trimmed = rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const key of uniform) delete copy[key];
    return copy;
  });
  return { rows: trimmed, shared };
}
