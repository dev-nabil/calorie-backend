import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode } from '../../shared';

/** An error with a stable code, rendered as { error: { code, message, details } }. */
export class ApiError extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details: Record<string, unknown> = {},
    public readonly headers: Record<string, string> = {},
  ) {
    super({ code, message, details }, status);
  }

  static notFound(code: ErrorCode = ERROR_CODES.NOT_FOUND, message = 'Not found'): ApiError {
    return new ApiError(code, message, HttpStatus.NOT_FOUND);
  }
  static unauthenticated(code: ErrorCode = ERROR_CODES.UNAUTHENTICATED, message = 'Sign in required'): ApiError {
    return new ApiError(code, message, HttpStatus.UNAUTHORIZED);
  }
  static forbidden(code: ErrorCode = ERROR_CODES.FORBIDDEN, message = 'Not allowed', details = {}): ApiError {
    return new ApiError(code, message, HttpStatus.FORBIDDEN, details);
  }
  static conflict(code: ErrorCode = ERROR_CODES.CONFLICT, message = 'Conflict', details = {}): ApiError {
    return new ApiError(code, message, HttpStatus.CONFLICT, details);
  }
  static rateLimited(retryAfterSec: number): ApiError {
    return new ApiError(
      ERROR_CODES.RATE_LIMITED,
      'Too many requests. Try again later.',
      HttpStatus.TOO_MANY_REQUESTS,
      { retryAfterSec },
      { 'Retry-After': String(retryAfterSec) },
    );
  }
}

/** HTTP status for domain error codes thrown by pure modules. */
export const DOMAIN_STATUS: Partial<Record<ErrorCode, HttpStatus>> = {
  QUESTION_NOT_FOUND: HttpStatus.NOT_FOUND,
  ANSWER_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  ANSWER_REQUIRED: HttpStatus.UNPROCESSABLE_ENTITY,
  QUESTION_NOT_APPLICABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  PLAN_NOT_ELIGIBLE: HttpStatus.UNPROCESSABLE_ENTITY,
  PLAN_OUT_OF_BOUNDS: HttpStatus.UNPROCESSABLE_ENTITY,
  PLAN_DRAFT_NOT_FOUND: HttpStatus.NOT_FOUND,
  PLAN_DRAFT_STALE: HttpStatus.CONFLICT,
  PLAN_GENERATION_IN_PROGRESS: HttpStatus.CONFLICT,
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  INVALID_DAY_KEY: HttpStatus.BAD_REQUEST,
  INVALID_TIMEZONE: HttpStatus.BAD_REQUEST,
};
