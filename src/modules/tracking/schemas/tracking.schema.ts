import { Schema, Types } from 'mongoose';
import {
  MEAL_CATEGORIES,
  MEAL_SOURCES,
  WEIGHT_SOURCES,
  type FoodPreparation,
  type MealCategory,
  type MealSource,
  type MealTotals,
  type NutrientTotals,
  type NutrientValues,
  type NutritionSource,
  type OtherNutrient,
  type WeightSource,
} from '../../../shared';

export interface StoredMealItem {
  name: string;
  grams: number;
  kcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  sugarG: number | null;
  sodiumMg: number | null;
  preparation: FoodPreparation | null;
  /** AnalysedItem.id of the scan this came from. */
  scanItemId: string | null;
  /** The basis of every value above; null for entries made before scans stored one. */
  per100g: NutrientValues | null;
  source: NutritionSource | null;
  otherNutrients: OtherNutrient[];
  confidence: number | null;
  edited: boolean;
  excluded: boolean;
  addedByUser: boolean;
}

export interface MealDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  date: string;
  timezone: string;
  loggedAt: Date;
  category: MealCategory;
  name: string;
  source: MealSource;
  scanId: string | null;
  photo: { key: string; thumbKey: string | null; displayKey?: string | null } | null;
  portionMultiplier: number;
  /** Items at the base portion (1×); totals apply the multiplier (plan 8.3 rule 6). */
  items: StoredMealItem[];
  totals: MealTotals;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ItemSchema = new Schema<StoredMealItem>(
  {
    name: String,
    grams: Number,
    kcal: Number,
    proteinG: Number,
    carbsG: Number,
    fatG: Number,
    fiberG: { type: Number, default: null },
    sugarG: { type: Number, default: null },
    sodiumMg: { type: Number, default: null },
    preparation: { type: String, default: null },
    scanItemId: { type: String, default: null },
    per100g: { type: Schema.Types.Mixed, default: null },
    source: { type: Schema.Types.Mixed, default: null },
    otherNutrients: { type: Schema.Types.Mixed, default: () => [] },
    confidence: { type: Number, default: null },
    edited: { type: Boolean, default: false },
    excluded: { type: Boolean, default: false },
    addedByUser: { type: Boolean, default: false },
  },
  { _id: false },
);

/** meals: diary entries, the source of truth for intake (S-10). */
export const MealSchema = new Schema<MealDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    date: { type: String, required: true },
    timezone: { type: String, required: true },
    loggedAt: { type: Date, required: true },
    category: { type: String, enum: MEAL_CATEGORIES, required: true },
    name: { type: String, required: true },
    source: { type: String, enum: MEAL_SOURCES, required: true },
    scanId: { type: String, default: null },
    photo: { type: new Schema({ key: String, thumbKey: { type: String, default: null }, displayKey: { type: String, default: null } }, { _id: false }), default: null },
    portionMultiplier: { type: Number, default: 1 },
    items: { type: [ItemSchema], default: [] },
    totals: { kcal: Number, proteinG: Number, carbsG: Number, fatG: Number, fiberG: Number, sugarG: Number, sodiumMg: Number, incomplete: { type: [String], default: [] } },
    deletedAt: { type: Date, default: null },
  },
  { collection: 'meals', timestamps: true, minimize: false },
);
MealSchema.index({ userId: 1, date: 1, deletedAt: 1 });
MealSchema.index({ userId: 1, loggedAt: 1 });
MealSchema.index({ userId: 1, scanId: 1 }, { unique: true, partialFilterExpression: { scanId: { $type: 'string' } } });

export interface DailyLogDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  date: string;
  totals: NutrientTotals;
  mealsCount: number;
  waterMl: number;
  waterEntries: { ml: number; at: Date; timezone: string }[];
  logged: boolean;
  recomputedAt: Date;
}

/** daily_logs: derived cache read by Today, recomputed from meals on every write (S-10). */
export const DailyLogSchema = new Schema<DailyLogDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    date: { type: String, required: true },
    totals: {
      kcal: { type: Number, default: 0 },
      proteinG: { type: Number, default: 0 },
      carbsG: { type: Number, default: 0 },
      fatG: { type: Number, default: 0 },
    },
    mealsCount: { type: Number, default: 0 },
    waterMl: { type: Number, default: 0 },
    waterEntries: { type: [new Schema({ ml: Number, at: Date, timezone: String }, { _id: false })], default: [] },
    logged: { type: Boolean, default: false },
    recomputedAt: { type: Date, default: () => new Date() },
  },
  { collection: 'daily_logs', timestamps: true, minimize: false },
);
DailyLogSchema.index({ userId: 1, date: 1 }, { unique: true });

export interface WeightLogDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  date: string;
  timezone: string;
  loggedAt: Date;
  weightKg: number;
  isEstimate: boolean;
  source: WeightSource;
  createdAt: Date;
}

/** weight_logs: weigh-ins with the timezone they were logged in (BR-07). */
export const WeightLogSchema = new Schema<WeightLogDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    date: { type: String, required: true },
    timezone: { type: String, required: true },
    loggedAt: { type: Date, required: true },
    weightKg: { type: Number, required: true },
    isEstimate: { type: Boolean, default: false },
    source: { type: String, enum: WEIGHT_SOURCES, default: 'manual' },
  },
  { collection: 'weight_logs', timestamps: true },
);
WeightLogSchema.index({ userId: 1, date: 1 });
WeightLogSchema.index({ userId: 1, loggedAt: 1 });
