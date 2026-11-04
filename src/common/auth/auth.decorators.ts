import { applyDecorators, createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import type { Request } from 'express';

export const IS_PUBLIC = 'nouri:isPublic';
/** Skips the access-token guard. */
export const Public = (): MethodDecorator =>
  applyDecorators(SetMetadata(IS_PUBLIC, true), ApiOperation({ security: [] } as Parameters<typeof ApiOperation>[0]));

export const OPTIONAL_AUTH = 'nouri:optionalAuth';
/** Public route that also reads a valid bearer token when one is sent (invalid tokens are ignored). */
export const OptionalAuth = (): MethodDecorator =>
  applyDecorators(Public(), SetMetadata(OPTIONAL_AUTH, true));

export interface AuthUser {
  id: string;
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      integrity?: { verified: boolean; enforced: boolean };
    }
  }
}

/** The signed-in user from the access token. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return req.authUser as AuthUser;
});
