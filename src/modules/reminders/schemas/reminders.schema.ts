import { Schema, Types } from 'mongoose';
import { type Weekday } from '../../../domain/reminders';

export interface ReminderDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: 'log_meal' | 'water';
  time: string;
  days: Weekday[];
  enabled: boolean;
  /** Repeats every this many hours from `time` until `endTime`; null = once a day. */
  everyHours?: number | null;
  endTime?: string | null;
  timezone: string;
  nextFireAtUtc: Date | null;
  lastFiredAt: Date | null;
}

/** reminders (plan section 6): index (enabled, nextFireAtUtc) drives the minute job. */
export const ReminderSchema = new Schema<ReminderDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, enum: ['log_meal', 'water'], required: true },
    time: { type: String, required: true },
    days: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
    everyHours: { type: Number, default: null },
    endTime: { type: String, default: null },
    timezone: { type: String, required: true },
    nextFireAtUtc: { type: Date, default: null },
    lastFiredAt: { type: Date, default: null },
  },
  { collection: 'reminders', timestamps: true },
);
ReminderSchema.index({ enabled: 1, nextFireAtUtc: 1 });
ReminderSchema.index({ userId: 1 });
