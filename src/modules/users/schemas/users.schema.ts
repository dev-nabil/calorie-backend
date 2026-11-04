import { Schema, Types } from 'mongoose';
import {
  AUTH_PROVIDERS,
  ENERGY_UNITS,
  ENTITLEMENT_PERIODS,
  ENTITLEMENT_PLANS,
  ENTITLEMENT_SOURCES,
  HEIGHT_UNITS,
  PLATFORMS,
  USER_STATUSES,
  WATER_UNITS,
  WEIGHT_UNITS,
  type AuthProvider,
  type EntitlementPeriod,
  type EntitlementPlan,
  type EntitlementSource,
  type Platform,
  type UnitPreferences,
  type UserStatus,
} from '../../../shared';

export interface UserDoc {
  _id: Types.ObjectId;
  email: string;
  emailVerifiedAt: Date | null;
  authProviders: { provider: AuthProvider; subject: string; emailVerified: boolean; linkedAt: Date }[];
  displayName: string | null;
  locale: string;
  timezone: string;
  units: UnitPreferences;
  status: UserStatus;
  entitlement: { plan: EntitlementPlan; period: EntitlementPeriod | null; activeUntil: Date | null; source: EntitlementSource | null };
  freeScans: { allowance: number; used: number };
  consents: {
    termsVersion: string | null;
    termsAt: Date | null;
    privacyVersion: string | null;
    privacyAt: Date | null;
    healthDataAt: Date | null;
    marketingAt: Date | null;
  };
  experiments: Record<string, string>;
  flags: { analyticsOptOut: boolean; voiceReplies: boolean };
  lastActiveAt: Date | null;
  deletionRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** users (plan section 6, M1-T1). */
export const UserSchema = new Schema<UserDoc>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    emailVerifiedAt: { type: Date, default: null },
    authProviders: [
      new Schema(
        {
          provider: { type: String, enum: AUTH_PROVIDERS, required: true },
          subject: { type: String, required: true },
          emailVerified: { type: Boolean, default: false },
          linkedAt: { type: Date, default: () => new Date() },
        },
        { _id: false },
      ),
    ],
    displayName: { type: String, default: null, maxlength: 50 },
    locale: { type: String, default: 'en-GB' },
    timezone: { type: String, default: 'UTC' },
    units: {
      weight: { type: String, enum: WEIGHT_UNITS, default: 'kg' },
      height: { type: String, enum: HEIGHT_UNITS, default: 'cm' },
      energy: { type: String, enum: ENERGY_UNITS, default: 'kcal' },
      water: { type: String, enum: WATER_UNITS, default: 'ml' },
    },
    status: { type: String, enum: USER_STATUSES, default: 'active' },
    entitlement: {
      plan: { type: String, enum: ENTITLEMENT_PLANS, default: 'free' },
      period: { type: String, enum: [...ENTITLEMENT_PERIODS, null], default: null },
      activeUntil: { type: Date, default: null },
      source: { type: String, enum: [...ENTITLEMENT_SOURCES, null], default: null },
    },
    freeScans: { allowance: { type: Number, default: 1 }, used: { type: Number, default: 0 } },
    consents: {
      termsVersion: { type: String, default: null },
      termsAt: { type: Date, default: null },
      privacyVersion: { type: String, default: null },
      privacyAt: { type: Date, default: null },
      healthDataAt: { type: Date, default: null },
      marketingAt: { type: Date, default: null },
    },
    // Keys contain dots (e.g. paywall.onboarding), so this is written as a whole object.
    experiments: { type: Schema.Types.Mixed, default: {} },
    flags: { analyticsOptOut: { type: Boolean, default: false }, voiceReplies: { type: Boolean, default: false } },
    lastActiveAt: { type: Date, default: null },
    deletionRequestedAt: { type: Date, default: null },
  },
  { collection: 'users', timestamps: true, minimize: false },
);
UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index(
  { 'authProviders.provider': 1, 'authProviders.subject': 1 },
  { unique: true, partialFilterExpression: { 'authProviders.subject': { $exists: true } } },
);
UserSchema.index({ status: 1, deletionRequestedAt: 1 });

export interface DeviceDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  deviceId: string;
  platform: Platform;
  appVersion: string | null;
  pushToken: string | null;
  lastSeenAt: Date;
  integrity: { verifiedAt: Date | null; keyId: string | null; publicKeyPem?: string | null; counter?: number; env?: string | null };
}

/** devices: one per user and device id (M1-T1, M1-T8). */
export const DeviceSchema = new Schema<DeviceDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    deviceId: { type: String, required: true },
    platform: { type: String, enum: PLATFORMS, required: true },
    appVersion: { type: String, default: null },
    pushToken: { type: String, default: null },
    lastSeenAt: { type: Date, default: () => new Date() },
    integrity: {
      verifiedAt: { type: Date, default: null },
      keyId: { type: String, default: null },
      publicKeyPem: { type: String, default: null },
      counter: { type: Number, default: 0 },
      env: { type: String, default: null },
    },
  },
  { collection: 'devices', timestamps: true },
);
DeviceSchema.index({ userId: 1, deviceId: 1 }, { unique: true });
DeviceSchema.index({ 'integrity.keyId': 1 }, { sparse: true });

export interface ScanLedgerDoc {
  emailHmac: string;
  freeScansUsed: number;
}

/** scan_ledger: free-scan use per HMAC of the email, survives account deletion (BR-01, S-14). */
export const ScanLedgerSchema = new Schema<ScanLedgerDoc>(
  { emailHmac: { type: String, required: true }, freeScansUsed: { type: Number, default: 0 } },
  { collection: 'scan_ledger', timestamps: true },
);
ScanLedgerSchema.index({ emailHmac: 1 }, { unique: true });
