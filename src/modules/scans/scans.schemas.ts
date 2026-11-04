import { Schema, Types } from 'mongoose';
import { MEAL_CATEGORIES, SCAN_STATUSES, type MealAnalysis, type MealCategory, type ScanStatus } from '../../shared';

export interface ScanDoc {
  _id: string; // scanId from the app (UUID v4)
  userId: Types.ObjectId;
  status: ScanStatus;
  imageKey: string;
  imageHash: string;
  category: MealCategory | null;
  timezone: string;
  /** Language the scan was started in (names and notes are written in it). */
  locale?: string | null;
  model: string | null;
  promptKey: string | null;
  promptVersion: number | null;
  result: MealAnalysis | null;
  rawOutput: unknown;
  error: { code: string; message: string } | null;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number };
  attempts: number;
  deduped: boolean;
  dedupedFrom: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  latencyMs: number | null;
  chargedFreeScan: boolean;
  createdAt: Date;
}

/** scans: one per AI photo analysis (plan section 6, M4-T3). */
export const ScanSchema = new Schema<ScanDoc>(
  {
    _id: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    status: { type: String, enum: SCAN_STATUSES, required: true },
    imageKey: { type: String, required: true },
    imageHash: { type: String, required: true },
    category: { type: String, enum: [...MEAL_CATEGORIES, null], default: null },
    timezone: { type: String, default: 'UTC' },
    locale: { type: String, default: null },
    model: { type: String, default: null },
    promptKey: { type: String, default: null },
    promptVersion: { type: Number, default: null },
    result: { type: Schema.Types.Mixed, default: null },
    rawOutput: { type: Schema.Types.Mixed, default: null },
    error: { type: Schema.Types.Mixed, default: null },
    usage: {
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
      cachedTokens: { type: Number, default: 0 },
      costUsd: { type: Number, default: 0 },
    },
    attempts: { type: Number, default: 0 },
    deduped: { type: Boolean, default: false },
    dedupedFrom: { type: String, default: null },
    queuedAt: { type: Date, required: true },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    latencyMs: { type: Number, default: null },
    chargedFreeScan: { type: Boolean, default: false },
  },
  { collection: 'scans', timestamps: true, minimize: false, _id: false },
);
ScanSchema.index({ userId: 1, createdAt: -1 });
ScanSchema.index({ userId: 1, imageHash: 1, status: 1 });
ScanSchema.index({ status: 1, queuedAt: 1 });

export interface AbuseEventDoc {
  kind: string;
  userId: Types.ObjectId | null;
  deviceId: string | null;
  ip: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

/** abuse_events: anomaly log for scan volume (M4-T7); 90-day TTL. */
export const AbuseEventSchema = new Schema<AbuseEventDoc>(
  {
    kind: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, default: null },
    deviceId: { type: String, default: null },
    ip: { type: String, default: null },
    details: { type: Schema.Types.Mixed, default: {} },
  },
  { collection: 'abuse_events', timestamps: { createdAt: true, updatedAt: false } },
);
AbuseEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86_400 });
AbuseEventSchema.index({ kind: 1, createdAt: -1 });
