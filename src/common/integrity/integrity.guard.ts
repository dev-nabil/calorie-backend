import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DEVICE_INTEGRITY_HEADER, ERROR_CODES } from '../../shared';
import { ApiError } from '../errors/api-error';
import { INTEGRITY_META, IntegrityVerifier, type IntegrityResult } from './integrity';
import { IntegritySettings } from './integrity-settings';

/** Rejects guarded requests without a valid assertion when enforcement is on; logs otherwise. */
@Injectable()
export class IntegrityGuard implements CanActivate {
  private readonly logger = new Logger('IntegrityGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: IntegrityVerifier,
    private readonly integrity: IntegritySettings,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!this.reflector.get<boolean>(INTEGRITY_META, ctx.getHandler())) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const enforced = await this.integrity.enforced();
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
