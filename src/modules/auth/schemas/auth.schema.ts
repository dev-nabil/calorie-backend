import { Schema, Types } from 'mongoose';

export interface SessionDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  family: string;
  deviceId: string | null;
  refreshTokenHash: string;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * sessions: one document per refresh token; rotation creates the next one in the same family.
 * The token is `<_id>.<secret>`, so lookups are by _id and no non-user index is needed.
 */
export const SessionSchema = new Schema<SessionDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    family: { type: String, required: true },
    deviceId: { type: String, default: null },
    refreshTokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    rotatedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { collection: 'sessions', timestamps: true },
);
SessionSchema.index({ userId: 1, family: 1 });
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export interface OtpCodeDoc {
  _id: Types.ObjectId;
  email: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
}

/** otp_codes: one pending code per email, hashed, removed by TTL after 10 minutes (BR-14). */
export const OtpCodeSchema = new Schema<OtpCodeDoc>(
  {
    email: { type: String, required: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'otp_codes', timestamps: true },
);
OtpCodeSchema.index({ email: 1 }, { unique: true });
OtpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
