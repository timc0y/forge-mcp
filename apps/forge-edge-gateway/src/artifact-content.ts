/**
 * How an artifact's bytes come back to the agent.
 *
 * `forge_artifact_get` used to return the bytes only for images; every other
 * type got metadata — `size_bytes`, `content_type` — and nothing else. Recovery
 * patches are stored as `text/plain; charset=utf-8`, so `forge_work_export`
 * was effectively write-only: the one artifact that exists to rescue work that
 * could not be pushed could be created, sized and described, but never read
 * back. That is the wrong half of the loop to have working.
 */
export function isTextualArtifact(mimeType: string): boolean {
  return /^(?:text\/|application\/(?:json|xml|x-patch|x-www-form-urlencoded)|application\/[\w.+-]*\+(?:json|xml))/iu.test(
    mimeType.trim()
  );
}
