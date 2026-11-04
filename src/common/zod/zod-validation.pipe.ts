import { ArgumentMetadata, HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import { z, ZodError, type ZodType } from 'zod';
import { ERROR_CODES } from '../../shared';
import { ApiError } from '../errors/api-error';

export function zodDetails(error: ZodError): Record<string, unknown> {
  return {
    issues: error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
  };
}

/** Validates and transforms one request part with a zod schema. Unknown fields are rejected by strict schemas. */
@Injectable()
export class ZodValidationPipe<T extends ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _meta: ArgumentMetadata): z.output<T> {
    const result = this.schema.safeParse(value ?? (_meta.type === 'body' ? {} : value));
    if (!result.success) {
      throw new ApiError(
        ERROR_CODES.VALIDATION_FAILED,
        `Invalid ${_meta.type === 'custom' ? 'input' : _meta.type}`,
        HttpStatus.BAD_REQUEST,
        zodDetails(result.error),
      );
    }
    return result.data;
  }
}
