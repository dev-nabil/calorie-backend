import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Response } from 'express';
import type { Model } from 'mongoose';
import { KvStore } from '../../../infra/kv/kv-store';
import { clock } from '../../../common/clock';
import type { AdminRole, AdminUserDoc } from '../schemas/admin.schema';
import { ADMIN_ABSOLUTE_SEC, ADMIN_CSRF_COOKIE, ADMIN_IDLE_SEC, ADMIN_PRINCIPAL_CACHE_SEC, ADMIN_SESSION_COOKIE } from '../security/admin-session.constants';
import type { AdminSessionData } from '../security/admin-session.types';

const key = (sid: string) => `admin:sess:${sid}`;
/** Cached role and status of an admin (shared through the KV store, so invalidation reaches every instance). */
const principalKey = (adminId: string) => `admin:principal:${adminId}`;
/** Sessions created at or before this time (ms) are revoked. Kept as long as a session can live. */
const revokedKey = (adminId: string) => `admin:revoked:${adminId}`;

interface AdminPrincipal {
  role: AdminRole;
  status: AdminUserDoc['status'];
}

/** Server-side admin sessions in the key-value store (opaque id cookie, CSRF double submit, sliding idle timeout). */
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
    // Idle and absolute limits use the (dev-shiftable) clock as well as the key TTL.
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
