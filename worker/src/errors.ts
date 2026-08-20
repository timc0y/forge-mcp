/**
 * One error type. Every failure a caller can act on is one of these codes, and
 * the message is written for the model that will read it: say what happened and
 * what to do instead, never a guessed cause.
 */
export type ForgeErrorCode =
  | 'FORGE_AUTH_REQUIRED'
  | 'FORGE_NOT_FOUND'
  | 'FORGE_AMBIGUOUS'
  | 'FORGE_VALIDATION_FAILED'
  | 'FORGE_CONFLICT'
  | 'FORGE_APPROVAL_REQUIRED'
  | 'FORGE_QUOTA_EXCEEDED'
  | 'FORGE_UPSTREAM_UNAVAILABLE';

export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  readonly retryable: boolean;
  /** Machine-readable specifics — candidate names, limits, conflicting paths. */
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: ForgeErrorCode;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = 'ForgeError';
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.details = input.details;
  }
}

export function isForgeError(value: unknown): value is ForgeError {
  return value instanceof ForgeError;
}

/**
 * An unexpected throw still has to reach the model as something it can act on.
 * Never invent a cause: an unknown failure says so.
 */
export function toForgeError(error: unknown): ForgeError {
  if (isForgeError(error)) return error;
  return new ForgeError({
    code: 'FORGE_UPSTREAM_UNAVAILABLE',
    message: error instanceof Error ? error.message : 'An unexpected failure occurred.',
    retryable: true
  });
}
