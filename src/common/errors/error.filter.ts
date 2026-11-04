import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { ERROR_CODES, type ApiErrorBody } from '../../shared';
import { DomainError } from '../../domain/errors';
import { ApiError, DOMAIN_STATUS } from './api-error';
import { zodDetails } from '../zod/zod-validation.pipe';
import { localizedError } from '../../shared/i18n';
import { requestLocale } from '../http/request-context';

const STATUS_CODES: Record<number, string> = {
  400: ERROR_CODES.BAD_REQUEST,
  401: ERROR_CODES.UNAUTHENTICATED,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
  413: ERROR_CODES.BAD_REQUEST,
  429: ERROR_CODES.RATE_LIMITED,
};

/** Renders every error as { error: { code, message, details } } (plan section 7). */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const { status, body, headers } = this.render(exception);
    // Non-English requests get the catalog text for the error code; English keeps the specific message the code raised.
    const localised = localizedError(requestLocale(), body.error.code, body.error.details);
    if (localised !== undefined) body.error.message = localised;
    if (status >= 500) {
      this.logger.error({ err: exception, path: req.path, requestId: req.id }, 'Unhandled error');
    }
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.status(status).json(body);
  }

  render(exception: unknown): { status: number; body: ApiErrorBody; headers: Record<string, string> } {
    const make = (status: number, code: string, message: string, details: Record<string, unknown> = {}, headers = {}) => ({
      status,
      body: { error: { code, message, details } },
      headers,
    });
    if (exception instanceof ApiError) {
      return make(exception.getStatus(), exception.code, exception.message, exception.details, exception.headers);
    }
    if (exception instanceof DomainError) {
      return make(DOMAIN_STATUS[exception.code] ?? HttpStatus.UNPROCESSABLE_ENTITY, exception.code, exception.message, exception.details);
    }
    if (exception instanceof ZodError) {
      return make(400, ERROR_CODES.VALIDATION_FAILED, 'Request validation failed', zodDetails(exception));
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resp = exception.getResponse();
      const message = typeof resp === 'string' ? resp : ((resp as { message?: unknown }).message ?? exception.message);
      if (exception.name === 'PayloadTooLargeError' || status === 413) {
        return make(413, ERROR_CODES.BAD_REQUEST, 'Request body too large');
      }
      return make(status, STATUS_CODES[status] ?? (status >= 500 ? ERROR_CODES.INTERNAL : ERROR_CODES.BAD_REQUEST), String(message));
    }
    const err = exception as { type?: string; status?: number; code?: number; keyValue?: unknown };
    if (err?.type === 'entity.parse.failed') return make(400, ERROR_CODES.BAD_REQUEST, 'Malformed JSON body');
    if (err?.type === 'entity.too.large') return make(413, ERROR_CODES.BAD_REQUEST, 'Request body too large');
    if (err?.code === 11000) return make(409, ERROR_CODES.CONFLICT, 'Duplicate record');
    return make(500, ERROR_CODES.INTERNAL, 'Something went wrong');
  }
}
