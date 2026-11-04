import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Request } from 'express';
import type { Model } from 'mongoose';
import type { AuditLogDoc } from '../schemas/admin.schema';
import type { AdminSessionData } from '../security/admin-session.types';

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
