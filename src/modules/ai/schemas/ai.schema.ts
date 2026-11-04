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
