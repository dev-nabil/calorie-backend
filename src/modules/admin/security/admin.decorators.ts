import { ExecutionContext, SetMetadata, applyDecorators, createParamDecorator } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader } from '@nestjs/swagger';
import type { Request } from 'express';
import { type AdminPermission } from './admin-rbac';
import { ADMIN_SESSION_COOKIE } from './admin-session.constants';
import type { AdminSessionData } from './admin-session.types';

export const ADMIN_PERMISSION_META = 'nouri:adminPermission';

/** Admin route: session cookie required, CSRF on writes, and the permission checked server-side. */
export function AdminRoute(permission: AdminPermission | null): MethodDecorator {
  return applyDecorators(
    SetMetadata(ADMIN_PERMISSION_META, permission ?? 'session'),
    ApiCookieAuth(ADMIN_SESSION_COOKIE),
    ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required on writes: the nouri_admin_csrf cookie value' }),
  );
}

export const CurrentAdmin = createParamDecorator((_d: unknown, ctx: ExecutionContext): AdminSessionData => ctx.switchToHttp().getRequest<Request>().admin!);
