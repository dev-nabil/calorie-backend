import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { Request } from 'express';
import { DEVICE_INTEGRITY_HEADER } from '../../shared';

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

export const INTEGRITY_META = 'nouri:integrity';
export function RequireIntegrity(): MethodDecorator {
  return applyDecorators(
    SetMetadata(INTEGRITY_META, true),
    ApiHeader({ name: DEVICE_INTEGRITY_HEADER, required: false, description: '`appattest.<keyId>.<assertion base64url>` or `playintegrity.<token>`, over the client data `${METHOD} ${path} ${X-Integrity-Timestamp}` (required in production, DEC-19)' }),
    ApiHeader({ name: 'X-Integrity-Timestamp', required: false, description: 'Milliseconds since epoch used in the signed client data (±5 minutes)' }),
  );
}

/** True when the request may use AI features (BR-16): verified, or enforcement off. */
export function integrityOk(req: Request): boolean {
  return Boolean(req.integrity?.verified || req.integrity?.enforced === false);
}
