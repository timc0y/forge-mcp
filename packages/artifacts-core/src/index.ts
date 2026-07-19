import type { ArtifactId, TenantId, WorkspaceId } from '@forge/core';
export interface ArtifactWriteInput { id: ArtifactId; tenantId: TenantId; workspaceId: WorkspaceId; kind: string; contentType: string; bytes: ArrayBuffer; metadata: Record<string,string|number|boolean|undefined>; }
export interface ArtifactRef { id: ArtifactId; key: string; contentType: string; sizeBytes: number; sha256: string; }
// `get`/`deleteWorkspace` take the tenant + workspace so the object key is
// derived directly. Deriving the key avoids listing (and linearly scanning) the
// whole bucket per call, which is O(bucket) in Class A ops and silently misses
// or leaks objects once a bucket exceeds the 1000-object list page.
export interface ArtifactStore { put(input: ArtifactWriteInput): Promise<ArtifactRef>; get(tenantId: TenantId, workspaceId: WorkspaceId, id: ArtifactId): Promise<Response | null>; deleteWorkspace(tenantId: TenantId, workspaceId: WorkspaceId): Promise<void>; }
