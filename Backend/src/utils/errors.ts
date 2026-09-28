export type ErrorCode =
  | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_EXTRACTION_FAILED' | 'SIMULATION_FAILED' | 'SIMULATION_LIMIT_EXCEEDED'
  | 'UPLOAD_INVALID' | 'UPLOAD_TOO_LARGE' | 'NEEDS_CLARIFICATION' | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400, NOT_FOUND: 404, CONFLICT: 409, AI_PROVIDER_UNAVAILABLE: 503,
  AI_EXTRACTION_FAILED: 422, SIMULATION_FAILED: 500, SIMULATION_LIMIT_EXCEEDED: 422,
  UPLOAD_INVALID: 400, UPLOAD_TOO_LARGE: 413, NEEDS_CLARIFICATION: 422, INTERNAL_ERROR: 500,
};

/** Framework-agnostic error. The HTTP layer maps `status`; the engine never imports Express. */
export class AppError extends Error {
  readonly status: number;
  constructor(public readonly code: ErrorCode, message: string, public readonly details: unknown[] = []) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}
