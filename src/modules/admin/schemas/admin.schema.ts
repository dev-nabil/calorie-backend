import { Schema, Types } from 'mongoose';

export const ADMIN_ROLES = ['owner', 'admin', 'support', 'editor', 'analyst'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface AdminUserDoc {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string | null;
  role: AdminRole;
  totpSecretEnc: string | null;
  status: 'active' | 'invited' | 'deactivated';
  lastLoginAt: Date | null;
  lastTotpStep: number | null;
  createdAt: Date;
}

/** admin_users (plan section 6, M1-T7). */
export const AdminUserSchema = new Schema<AdminUserDoc>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, default: null },
    role: { type: String, enum: ADMIN_ROLES, required: true },
    totpSecretEnc: { type: String, default: null },
    status: { type: String, enum: ['active', 'invited', 'deactivated'], default: 'active' },
    lastLoginAt: { type: Date, default: null },
    lastTotpStep: { type: Number, default: null },
  },
  { collection: 'admin_users', timestamps: true },
);
AdminUserSchema.index({ email: 1 }, { unique: true });

export interface AuditLogDoc {
  _id: Types.ObjectId;
  actorType: 'admin' | 'system';
  actorId: string;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  reason: string | null;
  diff: Record<string, unknown> | null;
  ip: string | null;
  createdAt: Date;
}

/** audit_logs: every admin write and every view of a user's health data; kept 2 years (BR-14). */
export const AuditLogSchema = new Schema<AuditLogDoc>(
  {
    actorType: { type: String, enum: ['admin', 'system'], required: true },
    actorId: { type: String, required: true },
    actorEmail: { type: String, default: null },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: String, default: null },
    reason: { type: String, default: null },
    diff: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
  },
  { collection: 'audit_logs', timestamps: { createdAt: true, updatedAt: false } },
);
AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
AuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 365 * 86_400 });
