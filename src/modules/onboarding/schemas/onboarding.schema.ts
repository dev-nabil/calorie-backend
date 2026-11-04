import { Schema, Types } from 'mongoose';
import {
  ACTIVITY_LEVELS,
  ANSWER_STATUSES,
  CALCULATION_SEXES,
  INPUT_METHODS,
  ONBOARDING_ROUTES,
  ONBOARDING_STATUSES,
  PROFILE_MODES,
  type AnswerDetail,
  type AnswerStatus,
  type AnswerValue,
  type EligibilityAttestation,
  type InputMethod,
  type OnboardingRoute,
  type OnboardingStatus,
} from '../../../shared';
import type { ProfileFields } from '../../../domain/onboarding-engine';
import type { EligibilityResult } from '../../../domain/plan-calculator';

export interface OnboardingAnswerDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  questionId: string;
  fieldKey: string;
  value: AnswerValue;
  detail: AnswerDetail | null;
  status: AnswerStatus;
  inputMethod: InputMethod;
  questionVersion: number;
  answeredAt: Date;
  history: { value: AnswerValue; detail: AnswerDetail | null; status: AnswerStatus; at: Date }[];
}

/** onboarding_answers: one current record per user and question; history capped at 10. */
export const OnboardingAnswerSchema = new Schema<OnboardingAnswerDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    questionId: { type: String, required: true },
    fieldKey: { type: String, required: true },
    value: { type: Schema.Types.Mixed, default: null },
    detail: { type: Schema.Types.Mixed, default: null },
    status: { type: String, enum: ANSWER_STATUSES, required: true },
    inputMethod: { type: String, enum: INPUT_METHODS, default: 'form' },
    questionVersion: { type: Number, default: 1 },
    answeredAt: { type: Date, required: true },
    history: { type: Schema.Types.Mixed, default: [] },
  },
  { collection: 'onboarding_answers', timestamps: true, minimize: false },
);
OnboardingAnswerSchema.index({ userId: 1, questionId: 1 }, { unique: true });

export type ProfileDoc = ProfileFields & {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  mode: 'full' | 'habits_only';
  eligibility: Omit<EligibilityResult, 'mode'>;
  attestation: EligibilityAttestation | null;
  onboarding: { route: OnboardingRoute; status: OnboardingStatus; questionSetVersion: number; completedAt: Date | null; deferredCount: number };
};

/** profiles: one per user, the current active onboarding values (plan section 6). */
export const ProfileSchema = new Schema<ProfileDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    primaryGoal: { type: String, default: null },
    supportingGoals: { type: [String], default: [] },
    personalMotivation: { type: String, default: null },
    requestedFeatures: { type: [String], default: [] },
    displayName: { type: String, default: null },
    ageYears: { type: Number, default: null },
    birthDate: { type: String, default: null },
    calculationSex: { type: String, enum: [...CALCULATION_SEXES, null], default: null },
    heightCm: { type: Number, default: null },
    weightKg: { type: Number, default: null },
    weightIsEstimate: { type: Boolean, default: false },
    targetWeightKg: { type: Number, default: null },
    activityLevel: { type: String, enum: [...ACTIVITY_LEVELS, null], default: null },
    dietPattern: { type: String, default: null },
    mealSource: { type: String, default: null },
    nutritionFamiliarity: { type: String, default: null },
    startingMood: { type: String, default: null },
    habitPriorities: { type: [String], default: [] },
    loggingMethods: { type: [String], default: [] },
    timeframeWeeks: { type: Number, default: null },
    allergies: { type: Schema.Types.Mixed, default: null },
    allergyOther: { type: String, default: null },
    dietPatternOther: { type: String, default: null },
    mealsPerDay: { type: String, default: null },
    schedulePattern: { type: String, default: null },
    higherIntakePattern: { type: String, default: null },
    trackingExperience: { type: String, default: null },
    routineBarriers: { type: [String], default: [] },
    eatingCues: { type: [String], default: [] },
    mode: { type: String, enum: PROFILE_MODES, default: 'habits_only' },
    eligibility: {
      adult: { type: Boolean, default: false },
      estimateAllowed: { type: Boolean, default: false },
      reasons: { type: [String], default: [] },
    },
    attestation: { type: Schema.Types.Mixed, default: null },
    onboarding: {
      route: { type: String, enum: ONBOARDING_ROUTES, default: 'detailed' },
      status: { type: String, enum: ONBOARDING_STATUSES, default: 'in_progress' },
      questionSetVersion: { type: Number, default: 1 },
      completedAt: { type: Date, default: null },
      deferredCount: { type: Number, default: 0 },
    },
  },
  { collection: 'profiles', timestamps: true, minimize: false },
);
ProfileSchema.index({ userId: 1 }, { unique: true });
