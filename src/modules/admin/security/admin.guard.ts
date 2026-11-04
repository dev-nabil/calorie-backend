import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ERROR_CODES } from '../../../shared';
import { ApiError } from '../../../common/errors/api-error';
import { adminCan, type AdminPermission } from './admin-rbac';
import { readCookie } from './admin-cookies';
import { ADMIN_SESSION_COOKIE } from './admin-session.constants';
import { ADMIN_PERMISSION_META } from './admin.decorators';
import { AdminSessions } from '../services/admin-sessions.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: AdminSessions,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.get<AdminPermission | 'session' | undefined>(ADMIN_PERMISSION_META, ctx.getHandler());
    if (!permission) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const sid = readCookie(req, ADMIN_SESSION_COOKIE);
    const session = sid ? await this.sessions.load(sid) : null;
    if (!session) throw ApiError.unauthenticated(ERROR_CODES.UNAUTHENTICATED, 'Admin session expired. Sign in again.');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const token = req.header('X-CSRF-Token') ?? '';
      const a = Buffer.from(token);
      const b = Buffer.from(session.csrf);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw ApiError.forbidden(ERROR_CODES.FORBIDDEN, 'CSRF token missing or invalid');
    }
    if (permission !== 'session' && !adminCan(session.role, permission)) {
      throw ApiError.forbidden(ERROR_CODES.FORBIDDEN, 'Your role cannot do this', { permission, role: session.role });
    }
    req.admin = session;
    return true;
  }
}
