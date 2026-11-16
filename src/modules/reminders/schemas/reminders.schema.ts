import { Schema, Types } from 'mongoose';
import { type ReminderKind, type Weekday } from '../../../domain/reminders';
import type { MealCategory } from '../../../shared';

export interface ReminderDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: ReminderKind;
  time: string;
  days: Weekday[];
  enabled: boolean;
  /** Ring again every N hours after `time` until `endTime` (null = once a day). */
  everyHours?: number | null;
  endTime?: string | null;
  /** log_meal: the slot (skipped once it has a meal that day). */
  category?: MealCategory | null;
  /** habit: which one; custom carries the person's own label. */
  habit?: string | null;
  label?: string | null;
  /** check_in: day_review. */
  checkIn?: string | null;
  /** No rings on or before this local day. */
  pausedUntil?: string | null;
  timezone: string;
  nextFireAtUtc: Date | null;
  lastFiredAt: Date | null;
}

/** reminders (plan section 6): index (enabled, nextFireAtUtc) drives the minute job. */
export const ReminderSchema = new Schema<ReminderDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, enum: ['log_meal', 'water', 'habit', 'weekly_review', 'check_in'], required: true },
    time: { type: String, required: true },
    days: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
    everyHours: { type: Number, default: null },
    endTime: { type: String, default: null },
    category: { type: String, default: null },
    habit: { type: String, default: null },
    label: { type: String, default: null },
    checkIn: { type: String, default: null },
    pausedUntil: { type: String, default: null },
    timezone: { type: String, required: true },
    nextFireAtUtc: { type: Date, default: null },
    lastFiredAt: { type: Date, default: null },
  },
  { collection: 'reminders', timestamps: true },
);
ReminderSchema.index({ enabled: 1, nextFireAtUtc: 1 });
ReminderSchema.index({ userId: 1 });

export interface ReminderSettingsDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  quietHours: { start: string; end: string } | null;
  pausedUntil: string | null;
  discreet: boolean;
  /** Local day the day was last reviewed in chat (check_in day_review is skipped that day). */
  dayReviewedOn: string | null;
  /** Monday of the week whose review was last opened in chat (weekly_review is skipped that week). */
  weekReviewedFrom: string | null;
}

/** reminder_settings (Milo buddy): one row per person; quiet hours default off, discreet lock-screen copy default on. Purged with the account. */
export const ReminderSettingsSchema = new Schema<ReminderSettingsDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    quietHours: { type: Schema.Types.Mixed, default: null },
    pausedUntil: { type: String, default: null },
    discreet: { type: Boolean, default: true },
    dayReviewedOn: { type: String, default: null },
    weekReviewedFrom: { type: String, default: null },
  },
  { collection: 'reminder_settings', timestamps: true, minimize: false },
);
ReminderSettingsSchema.index({ userId: 1 }, { unique: true });
