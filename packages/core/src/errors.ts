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
  | 'FORGE_FILE_NOT_FOUND'
  | 'FORGE_FILE_CONFLICT'
  | 'FORGE_PATCH_REJECTED'
  | 'FORGE_PROCESS_NOT_FOUND'
  | 'FORGE_TASK_NOT_FOUND'
  | 'FORGE_PREVIEW_UNAVAILABLE'
  | 'FORGE_GIT_DIRTY'
  | 'FORGE_GIT_PUSH_BLOCKED'
  | 'FORGE_GIT_FETCH_FAILED'
  | 'FORGE_WORKSPACE_GIT_STATE_DIVERGED'
  | 'FORGE_CHECKOUT_DATA_LOSS'
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

const FORGE_ERROR_CODES = new Set<string>([
  'FORGE_AUTH_REQUIRED', 'FORGE_PERMISSION_DENIED', 'FORGE_WORKSPACE_NOT_FOUND', 'FORGE_WORKSPACE_NOT_READY',
  'FORGE_WORKSPACE_CONFLICT', 'FORGE_STALE_REVISION', 'FORGE_LEASE_REQUIRED', 'FORGE_APPROVAL_REQUIRED',
  'FORGE_APPROVAL_EXPIRED', 'FORGE_COMMAND_TIMEOUT', 'FORGE_COMMAND_BLOCKED', 'FORGE_OUTPUT_TRUNCATED',
  'FORGE_ARTIFACT_NOT_FOUND', 'FORGE_FILE_NOT_FOUND', 'FORGE_FILE_CONFLICT', 'FORGE_PATCH_REJECTED',
  'FORGE_PROCESS_NOT_FOUND', 'FORGE_TASK_NOT_FOUND', 'FORGE_PREVIEW_UNAVAILABLE', 'FORGE_GIT_DIRTY',
  'FORGE_GIT_PUSH_BLOCKED', 'FORGE_GIT_FETCH_FAILED', 'FORGE_WORKSPACE_GIT_STATE_DIVERGED',
  'FORGE_CHECKOUT_DATA_LOSS', 'FORGE_PROVIDER_UNAVAILABLE', 'FORGE_QUOTA_EXCEEDED',
  'FORGE_SNAPSHOT_INCOMPATIBLE', 'FORGE_VALIDATION_FAILED', 'FORGE_INTERNAL_ERROR'
]);

function isForgeErrorCode(value: unknown): value is ForgeErrorCode {
  return typeof value === 'string' && FORGE_ERROR_CODES.has(value);
}

/**
 * Codes worth recovering from a message when the structured one is gone.
 *
 * Deliberately short. These three change what an agent should do next, and
 * getting them wrong is expensive: a stale revision means re-read before
 * retrying, a rejected patch means the edit did NOT land, and a blocked push
 * means the commit is real but local. Everything else can stay generic rather
 * than risk a confident mislabel.
 */
const INFERRED_CODES: ReadonlyArray<{ pattern: RegExp; code: ForgeErrorCode; retryable: boolean }> = [
  { pattern: /stale revision|expected_revision|expected revision|revision mismatch/iu, code: 'FORGE_STALE_REVISION', retryable: false },
  { pattern: /patch (?:was )?rejected|patch does not apply|patch did not apply|failed to apply .*(?:patch|hunk)|corrupt patch/iu, code: 'FORGE_PATCH_REJECTED', retryable: false },
  { pattern: /push (?:was )?(?:blocked|rejected|denied)|auto-push .*fail|failed to push/iu, code: 'FORGE_GIT_PUSH_BLOCKED', retryable: true }
];

export function toForgeError(error: unknown): ForgeError {
  if (error instanceof ForgeError) return error;

  // A ForgeError thrown inside a Durable Object arrives here as a plain Error
  // or plain object: the class identity does not survive the RPC boundary, so
  // `instanceof` is false even though every field is intact. Flattening those
  // into FORGE_INTERNAL_ERROR destroyed exactly what an agent keys its recovery
  // on — a rejected patch and a stale revision became the same opaque
  // "Forge could not complete the operation", and the agent retried blind.
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
  if (record && isForgeErrorCode(record.code)) {
    return new ForgeError({
      code: record.code,
      message: typeof record.message === 'string' && record.message ? record.message : 'Forge could not complete the operation.',
      retryable: record.retryable === true,
      ...(typeof record.operationId === 'string' ? { operationId: record.operationId as OperationId } : {}),
      ...(record.details && typeof record.details === 'object' ? { details: record.details as Record<string, unknown> } : {})
    });
  }

  // Preserve whatever diagnostic detail an unexpected failure carried so the
  // client sees something actionable instead of a bare FORGE_INTERNAL_ERROR.
  const details: Record<string, unknown> = {};
  let message = '';
  if (error instanceof Error) {
    if (error.name && error.name !== 'Error') details.cause = error.name;
    if (error.message) {
      message = error.message;
      details.reason = error.message.slice(0, 2_000);
    }
  } else if (typeof error === 'string' && error) {
    message = error;
    details.reason = error.slice(0, 2_000);
  }

  const inferred = message ? INFERRED_CODES.find((candidate) => candidate.pattern.test(message)) : undefined;
  if (inferred) {
    return new ForgeError({
      code: inferred.code,
      message: message.slice(0, 2_000),
      retryable: inferred.retryable,
      details: { ...details, codeInferredFromMessage: true }
    });
  }

  // The block above goes to the trouble of capturing `message` and stashing it
  // in details.reason so the client sees something actionable — and then this
  // return threw it away and sent the bare string anyway. Production shows what
  // that costs: three forge_edit failures whose entire agent-visible text was
  // "Forge could not complete the operation." on the one tool that matters
  // most. The reason was sitting in details the whole time.
  return new ForgeError({
    code: 'FORGE_INTERNAL_ERROR',
    message: message
      ? `Forge could not complete the operation: ${message.slice(0, 500)} This was not a fault Forge recognises, so there is no specific remedy — retry once, and if it repeats, report it rather than varying the arguments, which will not help.`
      : 'Forge could not complete the operation, and the failure carried no detail to report. Retry once; if it repeats, report it rather than varying the arguments, which will not help.',
    retryable: false,
    ...(Object.keys(details).length ? { details } : {})
  });
}
