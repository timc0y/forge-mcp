import type { ArtifactRef, ArtifactStore, ArtifactWriteInput } from '@forge/artifacts-core';
import type { ArtifactId, TenantId, WorkspaceId } from '@forge/core';

async function sha256(bytes: ArrayBuffer): Promise<string> { const digest = await crypto.subtle.digest('SHA-256', bytes); return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2,'0')).join(''); }
export class R2ArtifactStore implements ArtifactStore {
  constructor(private readonly bucket: R2Bucket) {}
  async put(input: ArtifactWriteInput): Promise<ArtifactRef> { const key = `tenant/${input.tenantId}/workspace/${input.workspaceId}/artifacts/${input.id}`; const hash = await sha256(input.bytes); await this.bucket.put(key, input.bytes, { httpMetadata: { contentType: input.contentType }, customMetadata: Object.fromEntries(Object.entries(input.metadata).filter(([,v]) => v !== undefined).map(([k,v]) => [k,String(v)])) }); return { id: input.id, key, contentType: input.contentType, sizeBytes: input.bytes.byteLength, sha256: hash }; }
  async get(tenantId: TenantId, workspaceId: WorkspaceId, id: ArtifactId): Promise<Response | null> { const key = `tenant/${tenantId}/workspace/${workspaceId}/artifacts/${id}`; const object = await this.bucket.get(key); return object ? new Response(object.body, { headers: { 'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream' } }) : null; }
  async deleteWorkspace(tenantId: TenantId, workspaceId: WorkspaceId): Promise<void> { const prefix = `tenant/${tenantId}/workspace/${workspaceId}/`; let cursor: string | undefined; do { const listing = await this.bucket.list({ prefix, cursor }); if (listing.objects.length) await this.bucket.delete(listing.objects.map((item) => item.key)); cursor = listing.truncated ? listing.cursor : undefined; } while (cursor); }
}
