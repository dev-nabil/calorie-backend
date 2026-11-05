import { z } from 'zod';
import { FOOD_PREPARATIONS, MEAL_CATEGORIES, MEAL_SOURCES, NUTRIENT_KEYS, NUTRITION_SOURCE_TYPES, OTHER_NUTRIENT_KEYS } from '../enums';
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

const known = z.number().nullable();

/** Seven nutrients per 100 g or per item. null means unknown; it is never written as zero. */
export const NutrientValuesSchema = z
  .object({ kcal: known, proteinG: known, carbsG: known, fatG: known, fiberG: known, sugarG: known, sodiumMg: known })
  .meta({ id: 'NutrientValues' });
export type NutrientValues = z.infer<typeof NutrientValuesSchema>;

/** Meal totals. A nutrient named in `incomplete` is the sum of the known items only, or null when none is known. */
export const MealTotalsSchema = NutrientValuesSchema.extend({
  incomplete: z.array(z.enum(NUTRIENT_KEYS)).describe('Nutrients unknown for at least one counted item'),
}).meta({ id: 'MealTotals' });
export type MealTotals = z.infer<typeof MealTotalsSchema>;

/** Where the per-100-gram values came from. */
export const NutritionSourceSchema = z
  .object({
    type: z.enum(NUTRITION_SOURCE_TYPES),
    recordId: z.string().nullable(),
    name: z.string().nullable().describe('Publisher of the record, for display'),
    reference: z.string().nullable().describe('Identifier inside that publication'),
  })
  .meta({ id: 'NutritionSource' });
export type NutritionSource = z.infer<typeof NutritionSourceSchema>;

/** Extra nutrients: only ever from a record, never from the model. */
export const OtherNutrientSchema = z
  .object({ key: z.enum(OTHER_NUTRIENT_KEYS), amount: z.number() })
  .meta({ id: 'OtherNutrient' });
export type OtherNutrient = z.infer<typeof OtherNutrientSchema>;

export const PointSchema = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .meta({ id: 'Point' });

const nutrient = z.number().min(0).max(1000);
const per100gInput = z.number().min(0).max(100000).nullable();

export const Per100gInputSchema = z
  .strictObject({ kcal: per100gInput, proteinG: per100gInput, carbsG: per100gInput, fatG: per100gInput, fiberG: per100gInput, sugarG: per100gInput, sodiumMg: per100gInput })
  .meta({ id: 'Per100gInput' });

/** One food at the base portion (multiplier 1). */
export const MealItemInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    grams: z.number().min(ITEM_GRAMS_MIN).max(ITEM_GRAMS_MAX),
    kcal: z.number().min(0).max(10000).nullable(),
    proteinG: nutrient.nullable(),
    carbsG: nutrient.nullable(),
    fatG: nutrient.nullable(),
    fiberG: nutrient.nullable().optional(),
    sugarG: nutrient.nullable().optional(),
    sodiumMg: z.number().min(0).max(100000).nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
    edited: z.boolean().optional(),
    excluded: z.boolean().optional(),
    addedByUser: z.boolean().optional(),
    preparation: z.enum(FOOD_PREPARATIONS).optional(),
    scanItemId: z.string().max(16).optional().describe('AnalysedItem.id: the server rebuilds this item from the stored scan, ignoring the numbers sent here'),
    per100g: Per100gInputSchema.optional().describe('Basis for items not from a scan; item values are then computed from it'),
  })
  .meta({ id: 'MealItemInput' });
export type MealItemInput = z.infer<typeof MealItemInputSchema>;

export const MealItemSchema = z
  .object({
    name: z.string(),
    grams: z.number(),
    kcal: known,
    proteinG: known,
    carbsG: known,
    fatG: known,
    fiberG: known,
    sugarG: known,
    sodiumMg: known,
    confidence: z.number().nullable(),
    edited: z.boolean(),
    excluded: z.boolean(),
    addedByUser: z.boolean(),
    preparation: z.enum(FOOD_PREPARATIONS).nullable(),
    scanItemId: z.string().nullable(),
    per100g: NutrientValuesSchema.nullable(),
    source: NutritionSourceSchema.nullable(),
    otherNutrients: z.array(OtherNutrientSchema),
    scaled: z
      .object({ grams: z.number(), kcal: known, proteinG: known, carbsG: known, fatG: known })
      .describe('Values after the portion multiplier'),
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
    totals: MealTotalsSchema,
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
