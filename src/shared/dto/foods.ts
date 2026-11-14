import { z } from 'zod';
import { FoodProcessingSchema, NutrientValuesSchema, NutritionSourceSchema, RichInSchema } from './meals';

/** GET /foods/barcode/{code}: a packaged product and the basis for logging it. */
export const BarcodeProductSchema = z
  .object({
    barcode: z.string(),
    found: z.boolean().describe('false: unknown barcode. Offer a label scan (POST /scans with mode "label" and this barcode)'),
    complete: z.boolean().describe('Energy and the three macros are known. When false, a label scan gives better numbers'),
    name: z.string().nullable(),
    brand: z.string().nullable(),
    servingG: z.number().nullable().describe('One serving in g (or ml), when known'),
    servingText: z.string().nullable().describe('Serving as printed on the pack'),
    packG: z.number().nullable().describe('Net weight or volume of the pack'),
    per100g: NutrientValuesSchema.describe('Per 100 g (or 100 ml); null when unknown, never 0 as a guess'),
    richIn: RichInSchema,
    processing: FoodProcessingSchema.describe('Open Food Facts NOVA group 1 → whole, 2 or 3 → processed, 4 → ultra_processed; from your own label scan when that is the source; null when unknown'),
    source: NutritionSourceSchema.nullable().describe('product_database (Open Food Facts) or package_label (your own label scan); null when not found'),
  })
  .meta({ id: 'BarcodeProduct' });
export type BarcodeProduct = z.infer<typeof BarcodeProductSchema>;
