import type { ArtifactId, TenantId, WorkspaceId } from '@forge/core';
export interface ArtifactWriteInput { id: ArtifactId; tenantId: TenantId; workspaceId: WorkspaceId; kind: string; contentType: string; bytes: ArrayBuffer; metadata: Record<string,string|number|boolean|undefined>; }
export interface ArtifactRef { id: ArtifactId; key: string; contentType: string; sizeBytes: number; sha256: string; }
export interface ArtifactStore { put(input: ArtifactWriteInput): Promise<ArtifactRef>; get(id: ArtifactId): Promise<Response | null>; deleteWorkspace(workspaceId: WorkspaceId): Promise<void>; }
