import { Schema, Types } from 'mongoose';
import { RECAP_RANGES, type RecapCard, type RecapRange, type RecapStats } from '../../../shared';

export interface WeeklyRecapDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  range: RecapRange;
  weekStart: string;
  weekEnd: string;
  /** The user's day the recap was made for (`this`); empty for `last`, whose week is over. */
  day: string;
  /** Language of the cards. */
  locale: string;
  mode: 'full' | 'habits_only';
  stats: RecapStats;
  cards: RecapCard[];
  /** True when the cards came from the model; false keeps an unusable answer from being paid for again. */
  ai: boolean;
  model: string | null;
  generatedAt: Date;
  /** TTL: the row is useless once its week (or day) is over. */
  expiresAt: Date;
}

/**
 * weekly_recaps: one model answer per user, range, week, language, mode and (for `this`) day, so a person triggers at most
 * one AI call per week for `last` and one per day for `this` (another language or a mode change makes a new one). Purged
 * with the account, exported, and removed by a TTL index.
 */
export const WeeklyRecapSchema = new Schema<WeeklyRecapDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    range: { type: String, enum: RECAP_RANGES, required: true },
    weekStart: { type: String, required: true },
    weekEnd: { type: String, required: true },
    day: { type: String, default: '' },
    locale: { type: String, required: true },
    mode: { type: String, enum: ['full', 'habits_only'], required: true },
    stats: { type: Schema.Types.Mixed, required: true },
    cards: { type: Schema.Types.Mixed, default: () => [] },
    ai: { type: Boolean, required: true },
    model: { type: String, default: null },
    generatedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'weekly_recaps', timestamps: true, minimize: false },
);
WeeklyRecapSchema.index({ userId: 1, range: 1, weekStart: 1, day: 1, locale: 1, mode: 1 }, { unique: true });
WeeklyRecapSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
