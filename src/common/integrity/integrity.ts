import { CanActivate, ExecutionContext, Inject, Injectable, Logger, SetMetadata, applyDecorators } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiHeader } from '@nestjs/swagger';
import type { Request } from 'express';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { DEVICE_INTEGRITY_HEADER, ERROR_CODES } from '../../shared';
import { ApiError } from '../errors/api-error';

export interface IntegrityResult {
  valid: boolean;
  reason?: string;
}

/**
 * DEC-19 device integrity. Production drivers verify Apple App Attest assertions and Google
 * Play Integrity tokens (M1-T8); the dev "allow" driver accepts any non-empty header.
 */
export interface IntegrityContext {
  path: string;
  method: string;
  userId?: string;
  /** X-Integrity-Timestamp (ms): bound into the signed client data `${method} ${path} ${timestamp}`. */
  timestamp?: string;
}

export abstract class IntegrityVerifier {
  abstract verify(token: string, ctx: IntegrityContext): Promise<IntegrityResult>;
}

export class AllowIntegrityVerifier extends IntegrityVerifier {
  async verify(token: string): Promise<IntegrityResult> {
    return token.trim() ? { valid: true } : { valid: false, reason: 'empty' };
  }
}

const META = 'nouri:integrity';
export function RequireIntegrity(): MethodDecorator {
  return applyDecorators(
    SetMetadata(META, true),
    ApiHeader({ name: DEVICE_INTEGRITY_HEADER, required: false, description: '`appattest.<keyId>.<assertion base64url>` or `playintegrity.<token>`, over the client data `${METHOD} ${path} ${X-Integrity-Timestamp}` (required in production, DEC-19)' }),
    ApiHeader({ name: 'X-Integrity-Timestamp', required: false, description: 'Milliseconds since epoch used in the signed client data (±5 minutes)' }),
  );
}

/** Rejects guarded requests without a valid assertion when enforcement is on; logs otherwise. */
@Injectable()
export class IntegrityGuard implements CanActivate {
  private readonly logger = new Logger('IntegrityGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: IntegrityVerifier,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!this.reflector.get<boolean>(META, ctx.getHandler())) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const enforced = this.config.integrityEnforced;
    const token = req.header(DEVICE_INTEGRITY_HEADER);
    const result: IntegrityResult = token
      ? await this.verifier.verify(token, { path: req.path, method: req.method, userId: req.authUser?.id, timestamp: req.header('X-Integrity-Timestamp') })
      : { valid: false, reason: 'missing' };
    req.integrity = { verified: result.valid, enforced };
    if (result.valid) return true;
    if (enforced) {
      throw token
        ? ApiError.forbidden(ERROR_CODES.INTEGRITY_INVALID, 'Device integrity check failed')
        : ApiError.forbidden(ERROR_CODES.INTEGRITY_REQUIRED, 'Device integrity assertion required');
    }
    this.logger.warn({ path: req.path, reason: result.reason }, 'integrity not verified (not enforced)');
    return true;
  }
}

/** True when the request may use AI features (BR-16): verified, or enforcement off. */
export function integrityOk(req: Request): boolean {
  return Boolean(req.integrity?.verified || req.integrity?.enforced === false);
}
