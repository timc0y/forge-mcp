/**
 * How an artifact's bytes come back to the agent.
 *
 * Textual artifacts are returned as decoded content; binary artifacts are
 * base64-encoded so every retained artifact type is readable.
 */
export function isTextualArtifact(mimeType: string): boolean {
  return /^(?:text\/|application\/(?:json|xml|x-patch|x-www-form-urlencoded)|application\/[\w.+-]*\+(?:json|xml))/iu.test(
    mimeType.trim()
  );
}
