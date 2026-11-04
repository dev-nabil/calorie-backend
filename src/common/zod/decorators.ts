import { applyDecorators, Body, Param, Query } from '@nestjs/common';
import { ApiBody, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';
import { ErrorResponseSchema } from '../../shared';
import { toOpenApi } from './openapi';
import { ZodValidationPipe } from './zod-validation.pipe';

type ParamDecorator = (target: object, key: string | symbol | undefined, index: number) => void;

function withMethodDoc(param: ParamDecorator, doc: MethodDecorator): ParamDecorator {
  return (target, key, index) => {
    param(target, key, index);
    if (key === undefined) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor) doc(target, key, descriptor);
  };
}

/** Validated JSON body (global validation via zod, plan section 7). */
export function ZBody(schema: ZodType): ParamDecorator {
  return withMethodDoc(Body(new ZodValidationPipe(schema)), ApiBody({ schema: toOpenApi(schema) }));
}

/** Validated query string; each top-level key is documented as a query parameter. */
export function ZQuery(schema: z.ZodObject): ParamDecorator {
  const docs = Object.entries(schema.shape).map(([name, field]) =>
    ApiQuery({ name, required: !(field as ZodType).safeParse(undefined).success, schema: toOpenApi(field as ZodType) }),
  );
  return withMethodDoc(Query(new ZodValidationPipe(schema)), applyDecorators(...docs));
}

/** Validated path parameter. */
export function ZParam(name: string, schema: ZodType): ParamDecorator {
  return withMethodDoc(Param(name, new ZodValidationPipe(schema)), ApiParam({ name, schema: toOpenApi(schema) as Record<string, unknown> }));
}

/** Documents a success response. */
export function ZResponse(status: number, schema: ZodType | null, description = 'OK'): MethodDecorator {
  return ApiResponse(schema ? { status, description, schema: toOpenApi(schema) } : { status, description });
}

/** Documents standard error responses. */
export function ApiErrors(...statuses: number[]): MethodDecorator {
  return applyDecorators(
    ...statuses.map((status) => ApiResponse({ status, description: 'Error', schema: toOpenApi(ErrorResponseSchema) })),
  );
}
