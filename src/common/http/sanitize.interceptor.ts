import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Types } from 'mongoose';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * BI-6: no Mongo internals in responses. `_id` becomes `id` (string) unless `id` exists, `__v`
 * is dropped, ObjectIds and Dates serialise as strings. Buffers and streams pass through.
 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 32 || value === null || value === undefined) return value;
  if (value instanceof Types.ObjectId) return value.toString();
  if (value instanceof Date || Buffer.isBuffer(value) || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const json = (value as { toJSON?: () => unknown }).toJSON;
    return typeof json === 'function' ? sanitize(json.call(value), depth + 1) : value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '__v') continue;
    if (k === '_id') {
      if (!('id' in (value as object))) out.id = v instanceof Types.ObjectId ? v.toString() : v;
      continue;
    }
    out[k] = sanitize(v, depth + 1);
  }
  return out;
}

@Injectable()
export class SanitizeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body: unknown) => sanitize(body)));
  }
}
