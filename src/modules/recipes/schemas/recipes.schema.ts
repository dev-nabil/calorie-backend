import { Schema, Types } from 'mongoose';
import type { DraftItem, MealTotals, NutrientValues } from '../../../shared';

export interface RecipeDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  /** Ingredients with their per-100 g basis; values recomputed by domain/chat-draft on every write. */
  items: DraftItem[];
  servings: number | null;
  cookedYieldG: number | null;
  rawWeightG: number;
  totals: MealTotals;
  per100gCooked: NutrientValues | null;
  version: number;
  createdFrom: { conversationId: string; draftId: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

/** recipes (Milo buddy, decision 0016): saved recipes, one row each. Purged with the account and exported. */
export const RecipeSchema = new Schema<RecipeDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    items: { type: Schema.Types.Mixed, default: [] },
    servings: { type: Number, default: null },
    cookedYieldG: { type: Number, default: null },
    rawWeightG: { type: Number, default: 0 },
    totals: { type: Schema.Types.Mixed, required: true },
    per100gCooked: { type: Schema.Types.Mixed, default: null },
    version: { type: Number, default: 1 },
    createdFrom: { type: Schema.Types.Mixed, default: null },
  },
  { collection: 'recipes', timestamps: true, minimize: false },
);
RecipeSchema.index({ userId: 1, updatedAt: -1 });
