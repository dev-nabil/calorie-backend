import { Schema, Types } from 'mongoose';
import {
  PLAN_METHODS,
  PLAN_OUTCOMES,
  PLAN_SOURCES,
  type MacroTargets,
  type PlanAiInfo,
  type PlanAssessment,
  type PlanMethod,
  type PlanNarrative,
  type PlanNotice,
  type PlanOutcome,
  type PlanPreview,
  type PlanSource,
  type PlanTimeframe,
} from '../../shared';

export interface PlanDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  active: boolean;
  version: number;
  source: PlanSource;
  energyKcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  waterMl: number;
  method: PlanMethod | null;
  goal: { type: string; startWeightKg: number | null; targetWeightKg: number | null; pace: 'gradual' | null };
  inputs: Record<string, unknown> | null;
  calculated: MacroTargets | null;
  confirmedAt: Date | null;
  createdAt: Date;
  /** PLAN-GEN: what the user reviewed and confirmed (all null for plans made without a draft). */
  draftId: Types.ObjectId | null;
  timeframe: PlanTimeframe | null;
  narrative: PlanNarrative | null;
  basis: string[];
  ai: PlanAiInfo | null;
  locale?: string | null;
}

/** plans: versioned targets, one active per user (plan section 6). */
export const PlanSchema = new Schema<PlanDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    active: { type: Boolean, default: false },
    version: { type: Number, required: true },
    source: { type: String, enum: PLAN_SOURCES, required: true },
    energyKcal: { type: Number, default: null },
    proteinG: { type: Number, default: null },
    carbsG: { type: Number, default: null },
    fatG: { type: Number, default: null },
    waterMl: { type: Number, default: 2500 },
    method: { type: String, enum: [...PLAN_METHODS, null], default: null },
    goal: {
      type: { type: String, default: 'habits' },
      startWeightKg: { type: Number, default: null },
      targetWeightKg: { type: Number, default: null },
      pace: { type: String, enum: ['gradual', null], default: null },
    },
    inputs: { type: Schema.Types.Mixed, default: null },
    calculated: { type: Schema.Types.Mixed, default: null },
    confirmedAt: { type: Date, default: null },
    draftId: { type: Schema.Types.ObjectId, default: null },
    timeframe: { type: Schema.Types.Mixed, default: null },
    narrative: { type: Schema.Types.Mixed, default: null },
    basis: { type: [String], default: [] },
    ai: { type: Schema.Types.Mixed, default: null },
    locale: { type: String, default: null },
  },
  { collection: 'plans', timestamps: true, minimize: false },
);
PlanSchema.index({ userId: 1, active: 1 });
PlanSchema.index({ userId: 1, version: -1 }, { unique: true });

export interface PlanDraftDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  inputHash: string;
  status: PlanOutcome;
  assessment: PlanAssessment;
  preview: PlanPreview;
  timeframe: PlanTimeframe | null;
  basis: string[];
  narrative: PlanNarrative | null;
  ai: PlanAiInfo;
  notice: PlanNotice | null;
  /** Earlier drafts made for these same answers. */
  regenerations: number;
  confirmedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
  /** Language code of the stored texts (en, bn). */
  locale?: string;
}

/** plan_drafts: what was generated and shown for review. Kept 30 days; the confirmed plan keeps its own copy. */
export const PlanDraftSchema = new Schema<PlanDraftDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    inputHash: { type: String, required: true },
    status: { type: String, enum: PLAN_OUTCOMES, required: true },
    assessment: { type: Schema.Types.Mixed, required: true },
    preview: { type: Schema.Types.Mixed, required: true },
    timeframe: { type: Schema.Types.Mixed, default: null },
    basis: { type: [String], default: [] },
    narrative: { type: Schema.Types.Mixed, default: null },
    ai: { type: Schema.Types.Mixed, required: true },
    notice: { type: Schema.Types.Mixed, default: null },
    regenerations: { type: Number, default: 0 },
    confirmedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    locale: { type: String, default: 'en' },
  },
  { collection: 'plan_drafts', timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);
PlanDraftSchema.index({ userId: 1, createdAt: -1 });
PlanDraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
