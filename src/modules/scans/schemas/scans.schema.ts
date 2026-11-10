import { Schema, Types } from 'mongoose';
import { MEAL_CATEGORIES, SCAN_MODES, SCAN_STATUSES, type MealAnalysis, type MealCategory, type ScanMode, type ScanStatus } from '../../../shared';

export interface ScanDoc {
  _id: string; // scanId from the app (UUID v4)
  userId: Types.ObjectId;
  status: ScanStatus;
  /** Missing on scans stored before label scans: those are meals. */
  mode?: ScanMode;
  /** Label scans: the pack's barcode, so a later barcode lookup finds this label. */
  barcode?: string | null;
  imageKey: string;
  imageHash: string;
  /** Hash of everything that shapes the reply; identical scans of one user share it. */
  cacheKey: string | null;
  /** Equals cacheKey while the model call is pending: a unique index lets only one run at a time. */
  inflightKey: string | null;
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
  usage: { inputTokens: number; outputTokens: number; thoughtTokens: number; cachedTokens: number; costUsd: number };
  attempts: number;
  /** Provider calls for this scan, retries included. */
  providerAttempts: number;
  modelLatencyMs: number | null;
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
    mode: { type: String, enum: SCAN_MODES, default: 'meal' },
    barcode: { type: String, default: null },
    imageKey: { type: String, required: true },
    imageHash: { type: String, required: true },
    cacheKey: { type: String, default: null },
    inflightKey: { type: String, default: null },
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
      thoughtTokens: { type: Number, default: 0 },
      cachedTokens: { type: Number, default: 0 },
      costUsd: { type: Number, default: 0 },
    },
    attempts: { type: Number, default: 0 },
    providerAttempts: { type: Number, default: 0 },
    modelLatencyMs: { type: Number, default: null },
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
ScanSchema.index({ userId: 1, cacheKey: 1, status: 1, finishedAt: -1 });
ScanSchema.index({ userId: 1, inflightKey: 1 }, { unique: true, partialFilterExpression: { inflightKey: { $type: 'string' } } });
ScanSchema.index({ status: 1, queuedAt: 1 });
ScanSchema.index({ userId: 1, barcode: 1, finishedAt: -1 }, { partialFilterExpression: { barcode: { $type: 'string' } } });

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
