import type { ArtifactRef, ArtifactStore, ArtifactWriteInput } from '@forge/artifacts-core';
import type { ArtifactId, WorkspaceId } from '@forge/core';

async function sha256(bytes: ArrayBuffer): Promise<string> { const digest = await crypto.subtle.digest('SHA-256', bytes); return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2,'0')).join(''); }
export class R2ArtifactStore implements ArtifactStore {
  constructor(private readonly bucket: R2Bucket) {}
  async put(input: ArtifactWriteInput): Promise<ArtifactRef> { const key = `tenant/${input.tenantId}/workspace/${input.workspaceId}/artifacts/${input.id}`; const hash = await sha256(input.bytes); await this.bucket.put(key, input.bytes, { httpMetadata: { contentType: input.contentType }, customMetadata: Object.fromEntries(Object.entries(input.metadata).filter(([,v]) => v !== undefined).map(([k,v]) => [k,String(v)])) }); return { id: input.id, key, contentType: input.contentType, sizeBytes: input.bytes.byteLength, sha256: hash }; }
  async get(id: ArtifactId): Promise<Response | null> { const objects = await this.bucket.list({ prefix: 'tenant/' }); const match = objects.objects.find((item) => item.key.endsWith(`/artifacts/${id}`)); if (!match) return null; const object = await this.bucket.get(match.key); return object ? new Response(object.body, { headers: { 'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream' } }) : null; }
  async deleteWorkspace(workspaceId: WorkspaceId): Promise<void> { const listing = await this.bucket.list({ prefix: `tenant/` }); const keys = listing.objects.filter((item) => item.key.includes(`/workspace/${workspaceId}/`)).map((item) => item.key); if (keys.length) await this.bucket.delete(keys); }
}
