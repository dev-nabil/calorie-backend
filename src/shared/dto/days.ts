import { z } from 'zod';
import { MEAL_CATEGORIES, PROGRESS_RANGES } from '../enums';
import { DayKeySchema, IsoDateTimeSchema, TimeZoneSchema } from './common';
import { MealSchema, NutrientTotalsSchema } from './meals';

export const WaterRequestSchema = z
  .strictObject({
    amountMl: z
      .number()
      .int()
      .min(-5000)
      .max(5000)
      .refine((v) => v !== 0 && v % 250 === 0, 'Water changes in 250 ml steps (BR-09)')
      .describe('Positive to add, negative to undo'),
    timezone: TimeZoneSchema,
    at: IsoDateTimeSchema.optional(),
  })
  .meta({ id: 'WaterRequest' });
export type WaterRequest = z.infer<typeof WaterRequestSchema>;

export const WaterStateSchema = z
  .object({
    totalMl: z.number().int(),
    targetMl: z.number().int(),
    stepMl: z.number().int(),
    entries: z.array(z.object({ ml: z.number().int(), at: IsoDateTimeSchema, timezone: z.string() })),
  })
  .meta({ id: 'WaterState' });

export const StreakSchema = z
  .object({
    current: z.number().int(),
    longest: z.number().int(),
    loggedToday: z.boolean(),
    week: z.array(z.object({ date: z.string(), logged: z.boolean() })),
    loggedThisWeek: z.number().int(),
  })
  .meta({ id: 'Streak' });
export type Streak = z.infer<typeof StreakSchema>;

export const DayTargetsSchema = z
  .object({
    energyKcal: z.number().int().nullable(),
    proteinG: z.number().int().nullable(),
    carbsG: z.number().int().nullable(),
    fatG: z.number().int().nullable(),
    waterMl: z.number().int(),
  })
  .meta({ id: 'DayTargets' });

export const DayResponseSchema = z
  .object({
    date: z.string(),
    targets: DayTargetsSchema,
    totals: NutrientTotalsSchema,
    remaining: z.object({
      kcal: z.number().nullable(),
      proteinG: z.number().nullable(),
      carbsG: z.number().nullable(),
      fatG: z.number().nullable(),
      waterMl: z.number().int(),
    }),
    meals: z.array(MealSchema),
    categories: z.array(
      z.object({ category: z.enum(MEAL_CATEGORIES), totals: NutrientTotalsSchema, mealCount: z.number().int() }),
    ),
    water: WaterStateSchema,
    streak: StreakSchema,
    nudge: z
      .object({ id: z.string(), category: z.enum(MEAL_CATEGORIES).nullable() })
      .nullable()
      .describe('Rule-based nudge; copy lives in content'),
  })
  .meta({ id: 'DayResponse' });
export type DayResponse = z.infer<typeof DayResponseSchema>;

export const CreateWeightRequestSchema = z
  .strictObject({
    weightKg: z.number().min(20).max(400),
    timezone: TimeZoneSchema,
    loggedAt: IsoDateTimeSchema.optional(),
    date: DayKeySchema.optional(),
    isEstimate: z.boolean().optional(),
  })
  .meta({ id: 'CreateWeightRequest' });
export type CreateWeightRequest = z.infer<typeof CreateWeightRequestSchema>;

export const WeightEntrySchema = z
  .object({
    id: z.string(),
    date: z.string(),
    timezone: z.string(),
    loggedAt: IsoDateTimeSchema,
    weightKg: z.number(),
    isEstimate: z.boolean(),
    source: z.enum(['onboarding', 'manual']),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'WeightEntry' });
export type WeightEntry = z.infer<typeof WeightEntrySchema>;

export const ListWeightsQuerySchema = z.strictObject({
  from: DayKeySchema.optional(),
  to: DayKeySchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const WeightListSchema = z
  .object({ items: z.array(WeightEntrySchema), nextCursor: z.string().nullable() })
  .meta({ id: 'WeightList' });

export const ProgressQuerySchema = z.strictObject({
  range: z.enum(PROGRESS_RANGES),
  date: DayKeySchema.optional().describe('Last day of the range; defaults to today in the user timezone'),
});

export const ProgressResponseSchema = z
  .object({
    range: z.enum(PROGRESS_RANGES),
    from: z.string(),
    to: z.string(),
    days: z.array(
      z.object({ date: z.string(), kcal: z.number(), logged: z.boolean(), waterMl: z.number().int() }),
    ),
    targetKcal: z.number().int().nullable(),
    averageKcal: z.number().nullable().describe('Average over logged days only'),
    loggedDays: z.number().int(),
    weights: z.array(z.object({ date: z.string(), weightKg: z.number(), isEstimate: z.boolean() })),
    goal: z.object({
      startWeightKg: z.number().nullable(),
      currentWeightKg: z.number().nullable(),
      targetWeightKg: z.number().nullable(),
    }),
    streak: StreakSchema,
  })
  .meta({ id: 'ProgressResponse' });
export type ProgressResponse = z.infer<typeof ProgressResponseSchema>;

const weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');
/** Reminder kinds. habit, weekly_review and check_in arrived with the Milo buddy (16 Nov 2026); old builds send only the first two. */
export const REMINDER_TYPES = ['log_meal', 'water', 'habit', 'weekly_review', 'check_in'] as const;
export type ReminderType = (typeof REMINDER_TYPES)[number];
export const REMINDER_HABITS = ['fruit_veg', 'protein', 'movement', 'sleep', 'custom'] as const;
export const REMINDER_CHECK_INS = ['day_review'] as const;
export const ReminderInputSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{24}$/, 'Expected an id').optional().describe('Send back the id of an existing reminder to keep it (an edit updates it); missing = a new reminder'),
  type: z.enum(REMINDER_TYPES),
  time: hhmm,
  days: z.array(weekday).max(7).optional().describe('Empty or missing = every day. weekly_review: exactly one day'),
  enabled: z.boolean(),
  everyHours: z.number().int().min(1).max(12).nullable().optional().describe('Ring again every N hours after `time`, up to `endTime`. Missing or null = once a day'),
  endTime: hhmm.nullable().optional().describe('Last ring (HH:mm), later the same day than `time`. Required with `everyHours`, ignored without it'),
  category: z.enum(MEAL_CATEGORIES).nullable().optional().describe('log_meal: the meal slot; the ring is skipped once that slot has a meal that day'),
  habit: z.enum(REMINDER_HABITS).nullable().optional().describe('type habit: which habit'),
  label: z.string().trim().min(1).max(60).nullable().optional().describe('type habit with habit custom: the person\'s own words (shown only on an unlocked screen)'),
  checkIn: z.enum(REMINDER_CHECK_INS).nullable().optional().describe('type check_in: day_review (skipped once the day was reviewed in chat)'),
  pausedUntil: DayKeySchema.nullable().optional().describe('No rings until the end of this day (local)'),
});
export type ReminderInput = z.infer<typeof ReminderInputSchema>;
export const ReminderSettingsSchema = z
  .object({
    quietHours: z.object({ start: hhmm, end: hhmm }).nullable().describe('null = off (default). Rings inside the window are skipped, never sent later'),
    pausedUntil: DayKeySchema.nullable().describe('Pause every reminder until the end of this day (local)'),
    discreet: z.boolean().describe('Lock screen shows only "Nouri reminder" (default true)'),
  })
  .meta({ id: 'ReminderSettings' });
export type ReminderSettings = z.infer<typeof ReminderSettingsSchema>;
export const PutRemindersRequestSchema = z
  .strictObject({
    reminders: z.array(ReminderInputSchema).max(10),
    timezone: TimeZoneSchema.optional().describe('Device timezone; defaults to the profile timezone'),
    settings: ReminderSettingsSchema.partial().strict().optional().describe('Missing = keep the stored settings'),
  })
  .meta({ id: 'PutRemindersRequest' });
export type PutRemindersRequest = z.infer<typeof PutRemindersRequestSchema>;
export const ReminderViewSchema = z
  .object({
    id: z.string().describe('Stable: send it back to edit this reminder'),
    type: z.enum(REMINDER_TYPES),
    time: z.string(),
    days: z.array(weekday),
    enabled: z.boolean(),
    everyHours: z.number().int().nullable().describe('Null = once a day at `time`'),
    endTime: z.string().nullable().describe('Last ring of the day when `everyHours` is set'),
    category: z.enum(MEAL_CATEGORIES).nullable(),
    habit: z.enum(REMINDER_HABITS).nullable(),
    label: z.string().nullable(),
    checkIn: z.enum(REMINDER_CHECK_INS).nullable(),
    pausedUntil: z.string().nullable(),
    link: z.string().describe('App route the notification opens: /coach?qa=log_meal&category=…, /coach?qa=review_day, /coach?qa=weekly_review or /today'),
    nextFireAt: z.string().nullable().describe('Next ring after quiet hours and pauses; null when none'),
  })
  .meta({ id: 'ReminderView' });
export type ReminderView = z.infer<typeof ReminderViewSchema>;
export const RemindersResponseSchema = z
  .object({
    timezone: z.string(),
    maxPerDay: z.number().int(),
    reminders: z.array(ReminderViewSchema),
    settings: ReminderSettingsSchema,
  })
  .meta({ id: 'RemindersResponse' });
export type RemindersResponse = z.infer<typeof RemindersResponseSchema>;
