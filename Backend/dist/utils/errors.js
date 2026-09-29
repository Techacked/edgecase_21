"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppError = void 0;
const STATUS = {
    VALIDATION_ERROR: 400, NOT_FOUND: 404, CONFLICT: 409, AI_PROVIDER_UNAVAILABLE: 503,
    AI_EXTRACTION_FAILED: 422, SIMULATION_FAILED: 500, SIMULATION_LIMIT_EXCEEDED: 422,
    UPLOAD_INVALID: 400, UPLOAD_TOO_LARGE: 413, NEEDS_CLARIFICATION: 422, INTERNAL_ERROR: 500,
};
/** Framework-agnostic error. The HTTP layer maps `status`; the engine never imports Express. */
class AppError extends Error {
    code;
    details;
    status;
    constructor(code, message, details = []) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'AppError';
        this.status = STATUS[code];
    }
}
exports.AppError = AppError;
