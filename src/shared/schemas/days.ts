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
export const ReminderInputSchema = z.strictObject({
  type: z.enum(['log_meal', 'water']),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm'),
  days: z.array(weekday).max(7).optional().describe('Empty or missing = every day'),
  enabled: z.boolean(),
});
export const PutRemindersRequestSchema = z
  .strictObject({ reminders: z.array(ReminderInputSchema).max(10), timezone: TimeZoneSchema.optional().describe('Device timezone; defaults to the profile timezone') })
  .meta({ id: 'PutRemindersRequest' });
export type PutRemindersRequest = z.infer<typeof PutRemindersRequestSchema>;
export const RemindersResponseSchema = z
  .object({
    timezone: z.string(),
    quietHours: z.object({ start: z.string(), end: z.string() }),
    maxPerDay: z.number().int(),
    reminders: z.array(z.object({ id: z.string(), type: z.enum(['log_meal', 'water']), time: z.string(), days: z.array(weekday), enabled: z.boolean(), nextFireAt: z.string().nullable() })),
  })
  .meta({ id: 'RemindersResponse' });
