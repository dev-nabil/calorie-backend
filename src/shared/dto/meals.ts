import { z } from 'zod';
import { MEAL_CATEGORIES, MEAL_SOURCES } from '../enums';
import {
  ITEM_GRAMS_MAX,
  ITEM_GRAMS_MIN,
  MAX_MEAL_ITEMS,
  PORTION_MULTIPLIER_MAX,
  PORTION_MULTIPLIER_MIN,
} from '../constants';
import { DayKeySchema, IsoDateTimeSchema, TimeZoneSchema, UuidSchema } from './common';

export const NutrientTotalsSchema = z
  .object({
    kcal: z.number(),
    proteinG: z.number(),
    carbsG: z.number(),
    fatG: z.number(),
  })
  .meta({ id: 'NutrientTotals' });
export type NutrientTotals = z.infer<typeof NutrientTotalsSchema>;

export const PointSchema = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .meta({ id: 'Point' });

const nutrient = z.number().min(0).max(1000);

/** One food at the base portion (multiplier 1). */
export const MealItemInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    grams: z.number().min(ITEM_GRAMS_MIN).max(ITEM_GRAMS_MAX),
    kcal: z.number().min(0).max(10000),
    proteinG: nutrient,
    carbsG: nutrient,
    fatG: nutrient,
    fiberG: nutrient.optional(),
    confidence: z.number().min(0).max(1).optional(),
    edited: z.boolean().optional(),
    excluded: z.boolean().optional(),
    addedByUser: z.boolean().optional(),
  })
  .meta({ id: 'MealItemInput' });
export type MealItemInput = z.infer<typeof MealItemInputSchema>;

export const MealItemSchema = z
  .object({
    name: z.string(),
    grams: z.number(),
    kcal: z.number(),
    proteinG: z.number(),
    carbsG: z.number(),
    fatG: z.number(),
    fiberG: z.number().nullable(),
    confidence: z.number().nullable(),
    edited: z.boolean(),
    excluded: z.boolean(),
    addedByUser: z.boolean(),
    scaled: NutrientTotalsSchema.extend({ grams: z.number() }).describe(
      'Values after the portion multiplier',
    ),
  })
  .meta({ id: 'MealItem' });
export type MealItem = z.infer<typeof MealItemSchema>;

export const CreateMealRequestSchema = z
  .strictObject({
    loggedAt: IsoDateTimeSchema,
    timezone: TimeZoneSchema,
    date: DayKeySchema.optional().describe('Defaults to the day of loggedAt in timezone (BR-07)'),
    category: z.enum(MEAL_CATEGORIES),
    name: z.string().trim().min(1).max(120),
    source: z.enum(MEAL_SOURCES),
    scanId: UuidSchema.optional(),
    imageKey: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Key from POST /uploads/presign: "Save photo and finish later" saves a photo-only meal (items may be empty)'),
    portionMultiplier: z.number().min(PORTION_MULTIPLIER_MIN).max(PORTION_MULTIPLIER_MAX).optional(),
    items: z.array(MealItemInputSchema).max(MAX_MEAL_ITEMS),
  })
  .meta({ id: 'CreateMealRequest' });
export type CreateMealRequest = z.infer<typeof CreateMealRequestSchema>;

export const UpdateMealRequestSchema = z
  .strictObject({
    category: z.enum(MEAL_CATEGORIES).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    portionMultiplier: z.number().min(PORTION_MULTIPLIER_MIN).max(PORTION_MULTIPLIER_MAX).optional(),
    items: z.array(MealItemInputSchema).max(MAX_MEAL_ITEMS).optional(),
    date: DayKeySchema.optional(),
    timezone: TimeZoneSchema.optional(),
  })
  .meta({ id: 'UpdateMealRequest' });
export type UpdateMealRequest = z.infer<typeof UpdateMealRequestSchema>;

export const MealSchema = z
  .object({
    id: z.string(),
    date: z.string(),
    timezone: z.string(),
    loggedAt: IsoDateTimeSchema,
    category: z.enum(MEAL_CATEGORIES),
    name: z.string(),
    source: z.enum(MEAL_SOURCES),
    scanId: z.string().nullable(),
    photo: z
      .object({
        key: z.string(),
        thumbKey: z.string().nullable(),
        url: z.string().describe('Signed URL (1024 px when ready, else the original), valid 1 hour'),
        thumbUrl: z.string().nullable().describe('Signed 320 px thumbnail URL once the thumbnail job has run'),
      })
      .nullable(),
    portionMultiplier: z.number(),
    items: z.array(MealItemSchema),
    totals: NutrientTotalsSchema,
    deletedAt: IsoDateTimeSchema.nullable(),
    restorableUntil: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Meal' });
export type Meal = z.infer<typeof MealSchema>;

export const ListMealsQuerySchema = z.strictObject({
  from: DayKeySchema,
  to: DayKeySchema,
  includeDeleted: z.enum(['true', 'false']).optional(),
});
export type ListMealsQuery = z.infer<typeof ListMealsQuerySchema>;

export const MealListSchema = z
  .object({ items: z.array(MealSchema), nextCursor: z.string().nullable() })
  .meta({ id: 'MealList' });
