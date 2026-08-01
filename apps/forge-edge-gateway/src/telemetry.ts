/**
 * Cheap, non-cryptographic hash for repeat-call detection — not a secret.
 *
 * Hashes the INTENT of a call, not the attempt. `idempotency_key` is stripped
 * first, and that omission is the whole point: it is the one field guaranteed
 * to differ between two attempts at the same thing, so including it made every
 * retry look like new work.
 *
 * Production showed the cost. forge_workspace_create failed fifteen times in
 * two minutes against the workspace quota, byte-identical payloads apart from
 * a freshly minted key — and produced fifteen distinct hashes. The repeat
 * detector that exists to catch exactly that storm saw fifteen unrelated calls
 * and stayed silent. The field whose purpose is to make a retry safe was what
 * stopped the retry from being recognised.
 */
export async function hashArgs(input: unknown): Promise<string> {
  const intent =
    input && typeof input === 'object' && !Array.isArray(input)
      ? Object.fromEntries(
          Object.entries(input as Record<string, unknown>).filter(([key]) => key !== 'idempotency_key')
        )
      : input;
  const json = JSON.stringify(intent) ?? '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
