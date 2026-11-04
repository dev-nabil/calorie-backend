import { createHash } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { from, Observable, of } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { ERROR_CODES, IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_TTL_SECONDS } from '../../shared';
import { KvStore } from '../../infra/kv/kv-store';
import { ApiError } from '../errors/api-error';

const META = 'nouri:idempotent';
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const PENDING_TTL_SEC = 60;
export const REPLAY_HEADER = 'Idempotent-Replayed';

interface Stored {
  state: 'pending' | 'done';
  fingerprint: string;
  body?: unknown;
}

/**
 * DEC-20: creating POSTs carry an Idempotency-Key. The first response is kept for 24 hours
 * and replayed for the same key and body; a different body with the same key is rejected.
 */
export function Idempotent(): MethodDecorator {
  return applyDecorators(
    SetMetadata(META, true),
    ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: true, description: 'Client-generated key (UUID v4), 8–128 chars' }),
  );
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly kv: KvStore,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.reflector.get<boolean>(META, ctx.getHandler())) return next.handle();
    return from(this.begin(ctx)).pipe(
      mergeMap((started) => {
        if (started.replay) return of(started.body);
        return next.handle().pipe(
          mergeMap(async (body: unknown) => {
            const done: Stored = { state: 'done', fingerprint: started.fingerprint, body };
            await this.kv.set(started.key, JSON.stringify(done), IDEMPOTENCY_TTL_SECONDS);
            return body;
          }),
          catchError(async (err: unknown) => {
            await this.kv.del(started.key);
            throw err;
          }),
        );
      }),
    );
  }

  private async begin(
    ctx: ExecutionContext,
  ): Promise<{ replay: true; body: unknown } | { replay: false; key: string; fingerprint: string }> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const raw = req.header(IDEMPOTENCY_KEY_HEADER);
    if (!raw) {
      throw new ApiError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, `${IDEMPOTENCY_KEY_HEADER} header is required`);
    }
    if (!KEY_RE.test(raw)) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `${IDEMPOTENCY_KEY_HEADER} must be 8–128 characters [A-Za-z0-9._:-]`);
    }
    const scope = req.authUser?.id ?? `ip:${req.ip}`;
    const key = `idem:${scope}:${req.method}:${req.path}:${raw}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(req.body ?? null)).digest('hex');
    const pending: Stored = { state: 'pending', fingerprint };
    if (await this.kv.setIfAbsent(key, JSON.stringify(pending), PENDING_TTL_SEC)) {
      return { replay: false, key, fingerprint };
    }
    const existing = await this.kv.get(key);
    const stored = existing ? (JSON.parse(existing) as Stored) : null;
    if (!stored) return this.begin(ctx); // expired between calls
    if (stored.fingerprint !== fingerprint) {
      throw new ApiError(
        ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
        'This Idempotency-Key was used with a different request body',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (stored.state === 'pending') {
      throw ApiError.conflict(ERROR_CODES.IDEMPOTENCY_IN_PROGRESS, 'A request with this Idempotency-Key is in progress');
    }
    res.setHeader(REPLAY_HEADER, 'true');
    return { replay: true, body: stored.body };
  }
}
