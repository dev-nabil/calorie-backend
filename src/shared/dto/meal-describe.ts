import { z } from 'zod';
import { ITEM_GRAMS_MAX, ITEM_GRAMS_MIN, MAX_MEAL_ITEMS } from '../constants';
import { FOOD_PREPARATIONS, FOOD_PROCESSING, MEAL_CATEGORIES } from '../enums';
import { MealTotalsSchema, Per100gInputSchema } from './meals';
import { AnalysedItemSchema } from './scans';

/** How a described amount was given. Weights and volumes are converted by the server, never by the model. */
export const DESCRIBE_UNITS = ['g', 'kg', 'ml', 'l', 'piece', 'slice', 'cup', 'glass', 'bowl', 'plate', 'tbsp', 'tsp', 'serving', 'other'] as const;
export type DescribeUnit = (typeof DESCRIBE_UNITS)[number];

/** What the text-logging answer is: a draft to review, a draft with one question, or no food at all. */
export const DESCRIBE_STATUSES = ['ok', 'needs_info', 'not_food'] as const;
export type DescribeStatus = (typeof DESCRIBE_STATUSES)[number];

export const DESCRIBE_DAYS = ['today', 'yesterday'] as const;

const per100 = z.number().nullable();

/**
 * Raw model output for POST /meals/describe (content/prompts/meal-describe.v1.md). The model gives what each food is,
 * how much was eaten and its values per 100 g; the server does all arithmetic, so a per-100-g value can never be
 * shown as the total. Sizes and ranges are enforced by normaliseDescribe, not here (Gemini refuses some limits).
 */
export const MealDescribeOutputSchema = z.strictObject({
  status: z.enum(DESCRIBE_STATUSES).describe('"ok" when every food has an amount or a safe usual serving; "needs_info" when one missing detail would change the total a lot; "not_food" when the text is not about food or drink'),
  mealName: z.string().nullable().describe('2 to 6 word title in the reply language; null when there are no items'),
  category: z.enum(MEAL_CATEGORIES).nullable().describe('Only when the text says which meal it was ("for lunch", "দুপুরে", "breakfast"); otherwise null'),
  day: z.enum(DESCRIBE_DAYS).nullable().describe('"yesterday" only when the text says so; otherwise null'),
  items: z.array(
    z.strictObject({
      name: z.string().describe('Food or drink name in the reply language, specific and written out in full'),
      en: z.string().describe('Plain lowercase English name, for example "white rice", "chicken curry", "boiled egg"'),
      portion: z.string().describe('Only the amount, in the reply language: "215 g", "2 eggs", "1 glass", "1 plate"'),
      stated: z.boolean().describe('true only when the user said the amount of this food (a number, a weight, a volume or a count); false when you assumed it'),
      qty: z.number().nullable().describe('The number the user said for this food (215 for "215 g", 2 for "two eggs"); null when not said'),
      unit: z.enum(DESCRIBE_UNITS).nullable().describe('Unit of qty: g, kg, ml, l for weights and volumes; piece, slice, cup, glass, bowl, plate, tbsp, tsp, serving otherwise; null when qty is null'),
      g: z.number().describe('Edible grams of this food as eaten, for the whole amount (2 eggs = 100). For a stated weight this is that weight'),
      prep: z.enum(FOOD_PREPARATIONS),
      proc: z.enum(FOOD_PROCESSING).describe('whole = whole or minimally processed, home dishes of them, natural sugar; processed = added sugar, salt or oil, refined, or any juice; ultra_processed = industrial products with additives'),
      n: z
        .strictObject({ kcal: per100, p: per100, c: per100, f: per100, fib: per100, sug: per100, na: per100 })
        .describe('Values PER 100 g of this food (not for the amount eaten): kcal; protein, carbs, fat, fibre, sugar in g; sodium in mg. null when unknown'),
      conf: z.number().describe('0 to 1: how sure you are of the food and its amount'),
      assume: z.string().nullable().describe('A few words in the reply language when you assumed the kind of food or how it was made; null otherwise (never for the amount: the app shows assumed amounts itself)'),
    }),
  ),
  question: z.string().nullable().describe('In the reply language. needs_info: one short question (under 12 words) about the detail that matters most, usually an amount; not_food: one friendly line asking what they ate; otherwise null'),
});
export type MealDescribeOutput = z.infer<typeof MealDescribeOutputSchema>;

/** A food already in the draft the user is refining. Its basis keeps the same food's numbers stable across follow-ups. */
export const DescribeDraftItemSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    grams: z.number().min(ITEM_GRAMS_MIN).max(ITEM_GRAMS_MAX),
    portion: z.string().max(60).nullable().optional(),
    per100g: Per100gInputSchema.optional(),
  })
  .meta({ id: 'DescribeDraftItem' });
export type DescribeDraftItem = z.infer<typeof DescribeDraftItemSchema>;

export const MealDescribeRequestSchema = z
  .strictObject({
    text: z.string().trim().min(1).max(500).describe('The newest message: a meal description, an answer to the question, or a correction ("Actually, it was 150 g")'),
    history: z.array(z.string().trim().min(1).max(500)).max(6).optional().describe('Earlier messages of this logging session, oldest first'),
    draft: z
      .strictObject({ mealName: z.string().max(120).nullable().optional(), items: z.array(DescribeDraftItemSchema).min(1).max(MAX_MEAL_ITEMS) })
      .optional()
      .describe('The unsaved result the user is correcting; the answer replaces it as a whole. Never a saved meal'),
    category: z.enum(MEAL_CATEGORIES).optional().describe('The meal slot selected in the app'),
    inputMethod: z.enum(['typed', 'voice']).optional(),
  })
  .meta({ id: 'MealDescribeRequest' });
export type MealDescribeRequest = z.infer<typeof MealDescribeRequestSchema>;

export const DescribedItemSchema = AnalysedItemSchema.extend({
  quantityStated: z.boolean().describe('The user gave this amount; false when the serving was assumed (see assumption)'),
}).meta({ id: 'DescribedItem' });
export type DescribedItem = z.infer<typeof DescribedItemSchema>;

export const MealDescribeResponseSchema = z
  .object({
    status: z.enum(DESCRIBE_STATUSES),
    mealName: z.string().nullable(),
    items: z.array(DescribedItemSchema).describe('Values for the amount eaten, computed by the server from per100g'),
    totals: MealTotalsSchema,
    clarifyingQuestion: z.string().nullable().describe('One short follow-up; the app keeps the draft and sends the answer with it'),
    category: z.enum(MEAL_CATEGORIES).nullable().describe('Meal named in the text, if any'),
    day: z.enum(DESCRIBE_DAYS).nullable().describe('Day named in the text, if any'),
  })
  .meta({ id: 'MealDescribeResponse', description: 'Not saved; review then POST /meals with source "text"' });
export type MealDescribeResponse = z.infer<typeof MealDescribeResponseSchema>;

/** Spoken food logging: audio formats Gemini reads, as the app sends them (raw request body). */
export const TRANSCRIBE_AUDIO_TYPES = ['audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/aac', 'audio/mpeg', 'audio/ogg', 'audio/flac'] as const;
export const TRANSCRIBE_MAX_BYTES = 2_000_000;
export const TRANSCRIBE_STATUSES = ['ok', 'silence', 'unclear'] as const;

/** Raw model output for POST /meals/transcribe (content/prompts/meal-transcribe.v1.md). */
export const MealTranscribeOutputSchema = z.strictObject({
  status: z.enum(TRANSCRIBE_STATUSES).describe('"ok" when words were spoken; "silence" when nobody speaks; "unclear" when there is speech but it cannot be made out'),
  text: z.string().describe('Exactly what was said, in the language and script it was spoken in; numbers as digits; empty unless status is "ok"'),
  language: z.string().nullable().describe('Main spoken language as a short code ("bn", "en"), "mixed" for two languages, or null'),
});
export type MealTranscribeOutput = z.infer<typeof MealTranscribeOutputSchema>;

export const MealTranscribeResponseSchema = z
  .object({
    status: z.enum(TRANSCRIBE_STATUSES),
    text: z.string().describe('Editable text for the composer (at most 500 characters); empty unless status is ok'),
    language: z.string().nullable(),
  })
  .meta({ id: 'MealTranscribeResponse', description: 'Speech to text only; nothing is analysed or saved. Send the text to POST /meals/describe' });
export type MealTranscribeResponse = z.infer<typeof MealTranscribeResponseSchema>;
