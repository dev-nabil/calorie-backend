import { z } from 'zod';
import { MEAL_CATEGORIES, SCAN_STATUSES } from '../enums';
import { IsoDateTimeSchema, UuidSchema } from './common';
import { NutrientTotalsSchema, PointSchema } from './meals';

/** Raw model output for meal photo analysis (plan 8.3). Unknown fields are rejected. */
export const MealAnalysisItemOutputSchema = z.strictObject({
  name: z.string().min(1).max(120),
  portion: z.string().max(60).nullable(),
  grams: z.number(),
  kcal: z.number().min(0),
  proteinG: z.number().min(0),
  carbsG: z.number().min(0),
  fatG: z.number().min(0),
  fiberG: z.number().min(0).nullable(),
  confidence: z.number(),
  point: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
});

export const MealAnalysisOutputSchema = z.strictObject({
  isFood: z.boolean(),
  mealName: z.string().max(120).nullable(),
  items: z.array(MealAnalysisItemOutputSchema),
  notes: z.string().max(500).nullable(),
  clarifyingQuestion: z.string().max(200).nullable(),
});
export type MealAnalysisOutput = z.infer<typeof MealAnalysisOutputSchema>;

export const AnalysedItemSchema = z
  .object({
    name: z.string(),
    portion: z.string().nullable(),
    grams: z.number(),
    kcal: z.number(),
    proteinG: z.number(),
    carbsG: z.number(),
    fatG: z.number(),
    fiberG: z.number().nullable(),
    confidence: z.number(),
    point: PointSchema.nullable(),
    kcalRecomputed: z.boolean().describe('kcal recomputed from macros (rule 4)'),
  })
  .meta({ id: 'AnalysedItem' });
export type AnalysedItem = z.infer<typeof AnalysedItemSchema>;

export const MealAnalysisSchema = z
  .object({
    isFood: z.boolean(),
    mealName: z.string().nullable(),
    items: z.array(AnalysedItemSchema),
    totals: NutrientTotalsSchema,
    notes: z.string().nullable(),
    clarifyingQuestion: z.string().nullable(),
    reactionLineId: z.string().nullable().describe('Rule-based Milo reaction (R-10)'),
  })
  .meta({ id: 'MealAnalysis' });
export type MealAnalysis = z.infer<typeof MealAnalysisSchema>;

export const CreateScanRequestSchema = z
  .strictObject({
    scanId: UuidSchema,
    imageKey: z.string().min(1).max(512),
    imageHash: z.string().regex(/^[a-f0-9]{64}$/, 'Expected a SHA-256 hex digest'),
    category: z.enum(MEAL_CATEGORIES).optional(),
  })
  .meta({ id: 'CreateScanRequest' });
export type CreateScanRequest = z.infer<typeof CreateScanRequestSchema>;

export const ScanSchema = z
  .object({
    scanId: z.string(),
    status: z.enum(SCAN_STATUSES),
    category: z.enum(MEAL_CATEGORIES).nullable(),
    result: MealAnalysisSchema.nullable(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
    deduped: z.boolean(),
    chargedFreeScan: z.boolean(),
    queuedAt: IsoDateTimeSchema,
    finishedAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'Scan' });
export type Scan = z.infer<typeof ScanSchema>;

/** Raw model output for POST /meals/parse (content/prompts/meal-parse.v1.md). */
export const MealParseOutputSchema = z.strictObject({
  mealName: z.string().max(120),
  items: z.array(
    z.strictObject({
      name: z.string().min(1).max(120),
      portion: z.string().max(60),
      grams: z.number(),
      kcal: z.number().min(0),
      proteinG: z.number().min(0),
      carbsG: z.number().min(0),
      fatG: z.number().min(0),
      fiberG: z.number().min(0),
      confidence: z.number(),
    }),
  ),
  notes: z.string().max(500).nullable(),
  clarifyingQuestion: z.string().max(200).nullable(),
});
export type MealParseOutput = z.infer<typeof MealParseOutputSchema>;

export const MealParseRequestSchema = z
  .strictObject({
    text: z.string().trim().min(1).max(500).describe('Typed text or the on-device transcript'),
    mode: z.enum(['describe', 'add_item']).optional().describe('describe (default): whole meal; add_item: one food missed by a scan'),
    inputMethod: z.enum(['typed', 'voice']).optional(),
    category: z.enum(MEAL_CATEGORIES).optional(),
    existingItems: z.array(z.strictObject({ name: z.string().max(120), grams: z.number() })).max(15).optional(),
  })
  .meta({ id: 'MealParseRequest' });
export type MealParseRequest = z.infer<typeof MealParseRequestSchema>;

export const MealParseResponseSchema = z
  .object({
    mealName: z.string().nullable(),
    items: z.array(AnalysedItemSchema),
    totals: NutrientTotalsSchema,
    notes: z.string().nullable(),
    clarifyingQuestion: z.string().nullable(),
  })
  .meta({ id: 'MealParseResponse', description: 'Not saved; review then POST /meals' });
export type MealParseResponse = z.infer<typeof MealParseResponseSchema>;
