import { Schema } from 'mongoose';
import type { NutrientValues } from '../../../shared';

/**
 * products: Open Food Facts answers cached by barcode (not user data, so no userId). An unknown barcode is
 * cached too, for less time, so a pack scanned again and again does not ask the database every time.
 */
export interface ProductDoc {
  _id: string; // barcode
  found: boolean;
  name: string | null;
  brand: string | null;
  servingG: number | null;
  servingText: string | null;
  packG: number | null;
  per100g: NutrientValues | null;
  source: string;
  fetchedAt: Date;
  expiresAt: Date;
}

export const ProductSchema = new Schema<ProductDoc>(
  {
    _id: { type: String, required: true },
    found: { type: Boolean, required: true },
    name: { type: String, default: null },
    brand: { type: String, default: null },
    servingG: { type: Number, default: null },
    servingText: { type: String, default: null },
    packG: { type: Number, default: null },
    per100g: { type: Schema.Types.Mixed, default: null },
    source: { type: String, required: true },
    fetchedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'products', _id: false, minimize: false },
);
ProductSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
