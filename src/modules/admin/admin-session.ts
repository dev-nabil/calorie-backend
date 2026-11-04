import { randomBytes, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable, SetMetadata, applyDecorators, createParamDecorator } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Reflector } from '@nestjs/core';
import { ApiCookieAuth, ApiHeader } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Model } from 'mongoose';
import { ERROR_CODES } from '../../shared';
import { ApiError } from '../../common/errors/api-error';
import { KvStore } from '../../infra/kv/kv-store';
import { adminCan, type AdminPermission } from './admin-rbac';
import { clock } from '../../common/clock';
import type { AdminRole, AdminUserDoc, AuditLogDoc } from './admin.schemas';

export const ADMIN_SESSION_COOKIE = '__Host-nouri_admin';
export const ADMIN_CSRF_COOKIE = 'nouri_admin_csrf';
export const ADMIN_IDLE_SEC = 30 * 60; // plan section 12: idle timeout 30 minutes
export const ADMIN_ABSOLUTE_SEC = 12 * 3600;

export interface AdminSessionData {
  sid: string;
  adminId: string;
  email: string;
  role: AdminRole;
  csrf: string;
  createdAt: number;
  lastSeenAt: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminSessionData;
    }
  }
}

const key = (sid: string) => `admin:sess:${sid}`;
/** Cached role and status of an admin (shared through the KV store, so invalidation reaches every instance). */
const principalKey = (adminId: string) => `admin:principal:${adminId}`;
/** Sessions created at or before this time (ms) are revoked. Kept as long as a session can live. */
const revokedKey = (adminId: string) => `admin:revoked:${adminId}`;
export const ADMIN_PRINCIPAL_CACHE_SEC = 30;

interface AdminPrincipal {
  role: AdminRole;
  status: AdminUserDoc['status'];
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Server-side admin sessions in Redis (opaque id cookie, CSRF double submit, sliding idle timeout). */
@Injectable()
export class AdminSessions {
  constructor(
    private readonly kv: KvStore,
    @InjectModel('AdminUser') private readonly admins: Model<AdminUserDoc>,
  ) {}

  async create(admin: { id: string; email: string; role: AdminRole }, res: Response): Promise<AdminSessionData> {
    const now = clock.now().getTime();
    const data: AdminSessionData = { sid: randomBytes(32).toString('base64url'), adminId: admin.id, email: admin.email, role: admin.role, csrf: randomBytes(24).toString('base64url'), createdAt: now, lastSeenAt: now };
    await this.kv.set(key(data.sid), JSON.stringify(data), ADMIN_IDLE_SEC);
    res.cookie(ADMIN_SESSION_COOKIE, data.sid, { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
    res.cookie(ADMIN_CSRF_COOKIE, data.csrf, { httpOnly: false, secure: true, sameSite: 'strict', path: '/' });
    return data;
  }

  async load(sid: string): Promise<AdminSessionData | null> {
    const raw = await this.kv.get(key(sid));
    if (!raw) return null;
    const s = JSON.parse(raw) as AdminSessionData;
    const now = clock.now().getTime();
    // Idle and absolute limits use the (dev-shiftable) clock as well as the Redis TTL.
    if (now - s.createdAt > ADMIN_ABSOLUTE_SEC * 1000 || now - s.lastSeenAt > ADMIN_IDLE_SEC * 1000) {
      await this.kv.del(key(sid));
      return null;
    }
    // Role and status come from admin_users (cached at most 30 s), never from the session (B20).
    const [principal, revokedAt] = await Promise.all([this.principal(s.adminId), this.kv.get(revokedKey(s.adminId))]);
    if (!principal || principal.status !== 'active' || (revokedAt && s.createdAt <= Number(revokedAt))) {
      await this.kv.del(key(sid));
      return null;
    }
    s.role = principal.role;
    s.lastSeenAt = now;
    await this.kv.set(key(sid), JSON.stringify(s), ADMIN_IDLE_SEC);
    return s;
  }

  private async principal(adminId: string): Promise<AdminPrincipal | null> {
    const cached = await this.kv.get(principalKey(adminId));
    if (cached) return JSON.parse(cached) as AdminPrincipal;
    const doc = await this.admins.findById(adminId, { role: 1, status: 1 }).lean<AdminUserDoc>();
    if (!doc) return null;
    const p: AdminPrincipal = { role: doc.role, status: doc.status };
    await this.kv.set(principalKey(adminId), JSON.stringify(p), ADMIN_PRINCIPAL_CACHE_SEC);
    return p;
  }

  /** Call after any change to an admin's role or status. */
  async invalidate(adminId: string): Promise<void> {
    await this.kv.del(principalKey(adminId));
  }

  /** Ends every session of an admin, on every instance. */
  async revokeAll(adminId: string): Promise<void> {
    await this.kv.set(revokedKey(adminId), String(clock.now().getTime()), ADMIN_ABSOLUTE_SEC + 60);
    await this.invalidate(adminId);
  }

  async destroy(sid: string, res: Response): Promise<void> {
    await this.kv.del(key(sid));
    res.clearCookie(ADMIN_SESSION_COOKIE, { path: '/', secure: true, sameSite: 'strict' });
    res.clearCookie(ADMIN_CSRF_COOKIE, { path: '/', secure: true, sameSite: 'strict' });
  }

  static expiresAt(s: AdminSessionData): string {
    return new Date(Math.min(s.lastSeenAt + ADMIN_IDLE_SEC * 1000, s.createdAt + ADMIN_ABSOLUTE_SEC * 1000)).toISOString();
  }
}

const META = 'nouri:adminPermission';

/** Admin route: session cookie required, CSRF on writes, and the permission checked server-side. */
export function AdminRoute(permission: AdminPermission | null): MethodDecorator {
  return applyDecorators(
    SetMetadata(META, permission ?? 'session'),
    ApiCookieAuth(ADMIN_SESSION_COOKIE),
    ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required on writes: the nouri_admin_csrf cookie value' }),
  );
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: AdminSessions,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.get<AdminPermission | 'session' | undefined>(META, ctx.getHandler());
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

export const CurrentAdmin = createParamDecorator((_d: unknown, ctx: ExecutionContext): AdminSessionData => ctx.switchToHttp().getRequest<Request>().admin!);

/** Writes audit_logs entries (M7: every write and every view of health data). */
@Injectable()
export class AuditService {
  constructor(@InjectModel('AuditLog') private readonly logs: Model<AuditLogDoc>) {}

  async log(admin: AdminSessionData | null, req: Request, e: { action: string; targetType: string; targetId?: string | null; reason?: string | null; diff?: Record<string, unknown> | null }): Promise<void> {
    await this.logs.create({
      actorType: admin ? 'admin' : 'system',
      actorId: admin?.adminId ?? 'system',
      actorEmail: admin?.email ?? null,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId ?? null,
      reason: e.reason ?? null,
      diff: e.diff ?? null,
      ip: req.ip ?? null,
    });
  }
}
