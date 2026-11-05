import { Schema } from 'mongoose';

export interface AiUsageDailyDoc {
  date: string;
  feature: string;
  model: string;
  requests: number;
  failures: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** ai_usage_daily: aggregated per day, feature and model (plan 8.9, admin AI dashboard). */
export const AiUsageDailySchema = new Schema<AiUsageDailyDoc>(
  {
    date: { type: String, required: true },
    feature: { type: String, required: true },
    model: { type: String, required: true },
    requests: { type: Number, default: 0 },
    failures: { type: Number, default: 0 },
    inputTokens: { type: Number, default: 0 },
    cachedTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
  },
  { collection: 'ai_usage_daily', timestamps: true },
);
AiUsageDailySchema.index({ date: 1, feature: 1, model: 1 }, { unique: true });

export interface FoodScanUsageDailyDoc {
  _id: string; // UTC day, YYYY-MM-DD
  requests: number;
  failures: number;
  spendMicroUsd: number;
  /** Calls in flight right now. Counted against the caps, so concurrent scans cannot overshoot them. */
  reservedRequests: number;
  reservedMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
}

/** food_scan_usage_daily: the Gemini daily caps. Whole micro-dollars, so concurrent increments stay exact. */
export const FoodScanUsageDailySchema = new Schema<FoodScanUsageDailyDoc>(
  {
    _id: { type: String, required: true },
    requests: { type: Number, default: 0 },
    failures: { type: Number, default: 0 },
    spendMicroUsd: { type: Number, default: 0 },
    reservedRequests: { type: Number, default: 0 },
    reservedMicroUsd: { type: Number, default: 0 },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    thoughtTokens: { type: Number, default: 0 },
  },
  { collection: 'food_scan_usage_daily', timestamps: true, _id: false },
);
