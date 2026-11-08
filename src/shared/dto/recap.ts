import { z } from 'zod';
import { RECAP_MILO_STATES, RECAP_RANGES, RECAP_TOPICS } from '../enums';
import { IsoDateTimeSchema } from './common';

/** `locale` may also arrive here (the request language, like on every route); it is not part of the recap. */
export const RecapQuerySchema = z.object({
  range: z.enum(RECAP_RANGES).default('last').describe('last (default): the previous Monday–Sunday; this: Monday of this week through today (user timezone)'),
});
export type RecapQuery = z.infer<typeof RecapQuerySchema>;

export const RecapStatsSchema = z
  .object({
    loggedDays: z.number().int().describe('Days in the range with at least one meal'),
    daysInRange: z.number().int().describe('7 for last; 1 to 7 for this'),
    meals: z.number().int().describe('Meals logged in the range'),
    averageKcal: z.number().int().nullable().describe('Average energy over logged days; null in habits_only mode'),
    waterAvgMl: z.number().int().describe('Average water on the days water was logged, to the nearest 10 ml; 0 when none'),
    waterTargetMl: z.number().int().nullable().describe('Daily water target of the active plan (the default target without a plan)'),
    waterGoalDays: z.number().int().describe('Days in the range that reached the water target'),
    proteinGoalDays: z.number().int().nullable().describe('Logged days that reached the protein target; null in habits_only mode or without a protein target'),
    streak: z.number().int().describe('Current logging streak (the number Today shows)'),
    favouriteFood: z
      .object({ name: z.string(), count: z.number().int().describe('Meals it was in') })
      .nullable()
      .describe('Food logged most often in the range (in at least 2 meals), else null'),
  })
  .meta({ id: 'RecapStats' });
export type RecapStats = z.infer<typeof RecapStatsSchema>;

export const RecapCardSchema = z
  .object({
    id: z.string().describe('Topic of the card: logging, meals, energy, protein, water, streak, favourite or next_week (a repeat gets -2)'),
    title: z.string().describe('At most 40 characters'),
    text: z.string().describe('At most 160 characters; every number in it is one of the stats'),
    miloState: z.enum(RECAP_MILO_STATES),
  })
  .meta({ id: 'RecapCard' });
export type RecapCard = z.infer<typeof RecapCardSchema>;

export const WeeklyRecapSchema = z
  .object({
    range: z.enum(RECAP_RANGES),
    weekStart: z.string().describe('YYYY-MM-DD, a Monday'),
    weekEnd: z.string().describe('YYYY-MM-DD: the Sunday for last, today for this'),
    mode: z.enum(['full', 'habits_only']).describe('habits_only: no calorie numbers anywhere in the recap'),
    stats: RecapStatsSchema,
    cards: z.array(RecapCardSchema).describe("Milo's story cards in the app language; empty when ai is false (build cards from stats)"),
    ai: z.boolean().describe('false: nothing logged, Milo is resting, the daily limit is used or the answer was unusable'),
    generatedAt: IsoDateTimeSchema.describe('When stats and cards were computed. A recap with cards is kept: for the week (last) or the day (this)'),
  })
  .meta({ id: 'WeeklyRecap' });
export type WeeklyRecap = z.infer<typeof WeeklyRecapSchema>;

/** What the model returns (content/prompts/weekly-recap.v1.md); sizes and numbers are enforced by domain/weekly-recap. */
export const WeeklyRecapOutputSchema = z.strictObject({
  cards: z.array(
    z.strictObject({
      topic: z.enum(RECAP_TOPICS),
      title: z.string().describe('At most 40 characters'),
      text: z.string().describe('At most 160 characters'),
      miloState: z.enum(RECAP_MILO_STATES),
    }),
  ),
});
export type WeeklyRecapOutput = z.infer<typeof WeeklyRecapOutputSchema>;
