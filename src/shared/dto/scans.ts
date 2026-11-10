import { z } from 'zod';
import { MAX_MEAL_ITEMS, PORTION_MULTIPLIER_MAX, PORTION_MULTIPLIER_MIN } from '../constants';
import { FOOD_PREPARATIONS, FOOD_ROLES, LABEL_BASES, MEAL_CATEGORIES, RETAKE_REASONS, RICH_IN_KEYS, SCAN_MODES, SCAN_OUTCOMES, SCAN_STATUSES } from '../enums';
import { BarcodeSchema, IsoDateTimeSchema, UuidSchema } from './common';
import { MealTotalsSchema, NutrientTotalsSchema, NutrientValuesSchema, NutritionSourceSchema, OtherNutrientSchema, Per100gInputSchema, PointSchema, RichInSchema } from './meals';

const per100 = z.number().min(0).nullable();

/** One food in the model's reply. Keys are short because every one is billed as output on every item. */
export const MealAnalysisItemOutputSchema = z.strictObject({
  name: z.string().min(1).describe('Display name in the requested language'),
  en: z.string().min(1).describe('Plain lowercase English name, for example "white rice"'),
  g: z.number().describe('Estimated edible weight as served, in grams'),
  prep: z.enum(FOOD_PREPARATIONS),
  role: z.enum(FOOD_ROLES),
  of: z.number().int().nullable().describe('For a component: index of its mixed dish in items'),
  n: z
    .strictObject({ kcal: per100, p: per100, c: per100, f: per100, fib: per100, sug: per100, na: per100 })
    .describe('Per 100 g: kcal; protein, carbs, fat, fibre, sugar in g; sodium in mg. null when unknown, never 0 as a guess'),
  rich: z.array(z.enum(RICH_IN_KEYS)).describe('Up to 4 vitamins or minerals this food is a good source of in a normal serving, strongest first; empty when none'),
  conf: z.number().describe('0 to 1 for identity and portion together'),
  pt: z.strictObject({ x: z.number(), y: z.number() }).nullable().describe('Item centre, 0 to 1; null when not visible'),
  note: z.string().nullable().describe('Main assumption for this item, or null'),
});

/**
 * Raw model output for a meal photo (content/prompts/meal-scan.v4.md). Unknown fields are rejected. This also
 * generates the schema sent to Gemini, which refuses `maxItems` here ("too many states") and ignores string
 * lengths, so sizes are enforced by normaliseAnalysis instead: an over-long reply is trimmed, not failed.
 */
export const MealAnalysisOutputSchema = z.strictObject({
  status: z.enum(SCAN_OUTCOMES),
  mealName: z.string().nullable(),
  items: z.array(MealAnalysisItemOutputSchema),
  assumptions: z.array(z.string()),
  question: z.string().nullable().describe('One short clarification, or what is wrong with the photo'),
  retake: z.enum(RETAKE_REASONS).nullable(),
});
export type MealAnalysisOutput = z.infer<typeof MealAnalysisOutputSchema>;

const printed = z.number().nullable();

/**
 * Raw model output for a photo of a nutrition label (content/prompts/label-scan.v1.md). The model copies the
 * printed numbers and their basis; the server does every conversion, so no arithmetic is left to the model.
 */
export const LabelScanOutputSchema = z.strictObject({
  status: z.enum(SCAN_OUTCOMES).describe('"no_food" when no nutrition table is visible'),
  name: z.string().nullable().describe('Product name as printed (brand and product), or null when not visible'),
  en: z.string().nullable().describe('Plain lowercase English name of the product type, for example "chocolate biscuits"'),
  basis: z.enum(LABEL_BASES).describe('The column copied into n: per 100 g (or 100 ml), or per serving'),
  servingG: z.number().nullable().describe('Serving size in g or ml as printed, or null when the label gives none'),
  servingText: z.string().nullable().describe('Serving as printed, for example "2 biscuits (25 g)"'),
  packG: z.number().nullable().describe('Net weight or volume of the pack in g or ml, or null'),
  n: z
    .strictObject({ kcal: printed, kj: printed, p: printed, c: printed, f: printed, fib: printed, sug: printed, na: printed, salt: printed })
    .describe('Values exactly as printed for the basis: kcal and kJ energy; protein, carbs, fat, fibre, sugar, salt in g; sodium in mg. null when not printed'),
  rich: z.array(z.enum(RICH_IN_KEYS)).describe('Vitamins or minerals printed at 15% or more of the daily value per serving, strongest first; empty when none'),
  question: z.string().nullable().describe('What is wrong with the photo, or one short note on the label'),
  retake: z.enum(RETAKE_REASONS).nullable(),
});
export type LabelScanOutput = z.infer<typeof LabelScanOutputSchema>;

export const AnalysedItemSchema = z
  .object({
    id: z.string().describe('Stable within one scan; send it back as scanItemId'),
    name: z.string(),
    canonicalName: z.string().nullable().describe('English name used to look up records'),
    portion: z.string().nullable(),
    grams: z.number(),
    kcal: z.number().nullable(),
    proteinG: z.number().nullable(),
    carbsG: z.number().nullable(),
    fatG: z.number().nullable(),
    fiberG: z.number().nullable(),
    sugarG: z.number().nullable(),
    sodiumMg: z.number().nullable(),
    per100g: NutrientValuesSchema.describe('Basis for every value on this item; portion changes recalculate from it'),
    source: NutritionSourceSchema,
    otherNutrients: z.array(OtherNutrientSchema),
    richIn: RichInSchema,
    preparation: z.enum(FOOD_PREPARATIONS).nullable(),
    role: z.enum(FOOD_ROLES),
    excluded: z.boolean().describe('Left out of totals, for example an ingredient of a mixed dish'),
    countedIn: z.string().nullable().describe('id of the mixed dish that already contains this item'),
    assumption: z.string().nullable(),
    confidence: z.number(),
    point: PointSchema.nullable(),
    kcalRecomputed: z.boolean().describe('kcal recomputed from macros (rule 4)'),
  })
  .meta({ id: 'AnalysedItem' });
export type AnalysedItem = z.infer<typeof AnalysedItemSchema>;

export const MealAnalysisSchema = z
  .object({
    outcome: z.enum(SCAN_OUTCOMES),
    isFood: z.boolean(),
    isEstimate: z.boolean().describe('true for a meal photo (it cannot establish weight, ingredients or hidden oil); false for values read from a label'),
    mealName: z.string().nullable(),
    items: z.array(AnalysedItemSchema),
    totals: MealTotalsSchema,
    assumptions: z.array(z.string()),
    notes: z.string().nullable(),
    clarifyingQuestion: z.string().nullable(),
    retakeReason: z.enum(RETAKE_REASONS).nullable(),
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
    mode: z.enum(SCAN_MODES).optional().describe('meal (default): estimate a served meal; label: read the nutrition table on a pack'),
    barcode: BarcodeSchema.optional().describe('Label scans only: the pack\'s barcode, so GET /foods/barcode/{code} finds this label next time'),
  })
  .meta({ id: 'CreateScanRequest' });
export type CreateScanRequest = z.infer<typeof CreateScanRequestSchema>;

export const ScanSchema = z
  .object({
    scanId: z.string(),
    status: z.enum(SCAN_STATUSES),
    mode: z.enum(SCAN_MODES),
    barcode: z.string().nullable(),
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

/** Portion or name corrections on a finished scan. Never calls a model. */
export const RecalculateScanRequestSchema = z
  .strictObject({
    portionMultiplier: z.number().min(PORTION_MULTIPLIER_MIN).max(PORTION_MULTIPLIER_MAX).optional(),
    items: z
      .array(
        z.strictObject({
          id: z.string().max(16),
          name: z.string().trim().min(1).max(120).optional(),
          grams: z.number().min(1).max(2000).optional(),
          preparation: z.enum(FOOD_PREPARATIONS).optional(),
          excluded: z.boolean().optional(),
        }),
      )
      .max(MAX_MEAL_ITEMS)
      .optional(),
    addedItems: z
      .array(z.strictObject({ name: z.string().trim().min(1).max(120), grams: z.number().min(1).max(2000), per100g: Per100gInputSchema, excluded: z.boolean().optional() }))
      .max(MAX_MEAL_ITEMS)
      .optional()
      .describe('Foods added by text after the scan'),
  })
  .meta({ id: 'RecalculateScanRequest' });
export type RecalculateScanRequest = z.infer<typeof RecalculateScanRequestSchema>;

export const RecalculatedScanSchema = z
  .object({
    portionMultiplier: z.number(),
    items: z.array(AnalysedItemSchema).describe('Values at the base portion (1×)'),
    totals: MealTotalsSchema.describe('Counted items after the portion multiplier'),
    staleItems: z.array(z.string()).describe('Renamed items with no matching record: their nutrition is still the earlier estimate'),
  })
  .meta({ id: 'RecalculatedScan', description: 'Not saved; review then POST /meals' });
export type RecalculatedScan = z.infer<typeof RecalculatedScanSchema>;

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
