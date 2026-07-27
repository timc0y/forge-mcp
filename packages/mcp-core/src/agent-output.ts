/**
 * Helpers that keep MCP tool results small enough for ChatGPT / Claude hosts
 * while parking the full bytes in Forge artifacts or on GitHub.
 */

/** Spill shell / deploy output to an artifact once it exceeds this. */
export const AGENT_OUTPUT_SPILL_BYTES = 20_480;

/** Inline tails kept in the tool result when spilling. */
export const AGENT_OUTPUT_TAIL_BYTES = 2_048;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function tailBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return new TextDecoder().decode(bytes.slice(bytes.byteLength - maxBytes));
}

/**
 * Keep only the unified-diff file sections whose `a/` / `b/` paths match
 * `paths` (repo-relative or `/workspace/repo/...`). Empty `paths` → unchanged.
 */
export function filterUnifiedDiff(patch: string, paths: string[] | undefined): string {
  if (!paths?.length) return patch;
  const wanted = new Set(
    paths.map((path) =>
      path
        .replace(/^\/workspace\/repo\//u, '')
        .replace(/^\.\//u, '')
        .replace(/^a\//u, '')
        .replace(/^b\//u, '')
    )
  );
  const lines = patch.split('\n');
  const out: string[] = [];
  let keep = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/u);
      const a = match?.[1] ?? '';
      const b = match?.[2] ?? '';
      keep = wanted.has(a) || wanted.has(b);
      if (keep) out.push(line);
      continue;
    }
    if (keep) out.push(line);
  }
  const filtered = out.join('\n').replace(/\n+$/u, '\n');
  if (!filtered.trim()) {
    throw new Error(
      `No patch hunks matched paths: ${[...wanted].join(', ')}. Pass a smaller unified diff or use forge_files_write / forge_files_write_batch.`
    );
  }
  return filtered;
}
