import type { OperationId } from './ids';

export type ForgeErrorCode =
  | 'FORGE_AUTH_REQUIRED'
  | 'FORGE_PERMISSION_DENIED'
  | 'FORGE_WORKSPACE_NOT_FOUND'
  | 'FORGE_WORKSPACE_NOT_READY'
  | 'FORGE_WORKSPACE_CONFLICT'
  | 'FORGE_STALE_REVISION'
  | 'FORGE_LEASE_REQUIRED'
  | 'FORGE_APPROVAL_REQUIRED'
  | 'FORGE_APPROVAL_EXPIRED'
  | 'FORGE_COMMAND_TIMEOUT'
  | 'FORGE_COMMAND_BLOCKED'
  | 'FORGE_OUTPUT_TRUNCATED'
  | 'FORGE_ARTIFACT_NOT_FOUND'
  | 'FORGE_FILE_CONFLICT'
  | 'FORGE_PATCH_REJECTED'
  | 'FORGE_PROCESS_NOT_FOUND'
  | 'FORGE_PREVIEW_UNAVAILABLE'
  | 'FORGE_GIT_DIRTY'
  | 'FORGE_GIT_PUSH_BLOCKED'
  | 'FORGE_PROVIDER_UNAVAILABLE'
  | 'FORGE_QUOTA_EXCEEDED'
  | 'FORGE_SNAPSHOT_INCOMPATIBLE'
  | 'FORGE_VALIDATION_FAILED'
  | 'FORGE_INTERNAL_ERROR';

export interface ForgeErrorShape {
  code: ForgeErrorCode;
  message: string;
  retryable: boolean;
  operationId?: OperationId;
  details?: Record<string, unknown>;
}

export class ForgeError extends Error implements ForgeErrorShape {
  readonly code: ForgeErrorCode;
  readonly retryable: boolean;
  readonly operationId?: OperationId;
  readonly details?: Record<string, unknown>;

  constructor(shape: ForgeErrorShape) {
    super(shape.message);
    this.name = 'ForgeError';
    this.code = shape.code;
    this.retryable = shape.retryable;
    this.operationId = shape.operationId;
    this.details = shape.details;
  }

  toJSON(): ForgeErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.operationId ? { operationId: this.operationId } : {}),
      ...(this.details ? { details: this.details } : {})
    };
  }
}

export function toForgeError(error: unknown): ForgeError {
  if (error instanceof ForgeError) return error;
  return new ForgeError({ code: 'FORGE_INTERNAL_ERROR', message: 'Forge could not complete the operation.', retryable: false });
}
