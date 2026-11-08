import { z } from 'zod';
import { FRIDGE_MAX_IDEAS, FRIDGE_MAX_INGREDIENTS, FRIDGE_MAX_STEPS } from '../constants';

export const FridgeChefRequestSchema = z
  .strictObject({
    uploadKey: z.string().min(1).max(512).describe('`key` from POST /uploads/presign (kind meal_photo, image/jpeg) after the PUT. The photo is deleted after this call, whatever its outcome'),
  })
  .meta({ id: 'FridgeChefRequest' });
export type FridgeChefRequest = z.infer<typeof FridgeChefRequestSchema>;

export const FridgeChefIdeaSchema = z
  .object({
    name: z.string(),
    why: z.string().describe('One short line on why it fits'),
    minutes: z.number().int().describe('Rough total time'),
    kcal: z.number().int().nullable().describe('Estimated energy per serving; null in habits_only mode or when unknown'),
    uses: z.array(z.string()).describe('Ingredients from the photo it uses'),
    extra: z.array(z.string()).describe('Common items it also needs that are not in the photo'),
    steps: z.array(z.string()).describe(`At most ${FRIDGE_MAX_STEPS} short steps`),
  })
  .meta({ id: 'FridgeChefIdea' });
export type FridgeChefIdea = z.infer<typeof FridgeChefIdeaSchema>;

export const FridgeChefResponseSchema = z
  .object({
    notFood: z.boolean().describe('No usable food or ingredients found in the photo; ingredients and ideas are then empty'),
    ingredients: z.array(z.string()).describe(`What Milo could see, at most ${FRIDGE_MAX_INGREDIENTS}`),
    ideas: z.array(FridgeChefIdeaSchema).describe(`At most ${FRIDGE_MAX_IDEAS}; never with a listed allergen or against the eating pattern`),
  })
  .meta({ id: 'FridgeChefResponse' });
export type FridgeChefResponse = z.infer<typeof FridgeChefResponseSchema>;

/**
 * What the model returns (content/prompts/fridge-chef.v1.md). This also generates the schema sent to Gemini, which refuses
 * some size keywords, so list sizes and string lengths are enforced by domain/fridge-chef instead.
 */
export const FridgeChefOutputSchema = z.strictObject({
  notFood: z.boolean(),
  ingredients: z.array(z.string()),
  ideas: z.array(
    z.strictObject({
      name: z.string(),
      why: z.string(),
      minutes: z.number(),
      kcal: z.number().nullable(),
      uses: z.array(z.string()),
      extra: z.array(z.string()),
      steps: z.array(z.string()),
    }),
  ),
});
export type FridgeChefOutput = z.infer<typeof FridgeChefOutputSchema>;
