import type { ActorRef, OperationId, TenantId, WorkspaceId } from '@forge/core';

export interface ForgeEvent<T = unknown> {
  schemaVersion: 1;
  id: string;
  sequence?: number;
  traceId: string;
  operationId?: OperationId;
  tenantId: TenantId;
  workspaceId?: WorkspaceId;
  actor: ActorRef;
  type: string;
  occurredAt: string;
  payload: T;
}

export interface EventPublisher {
  publish<T>(event: ForgeEvent<T>): Promise<void>;
}
