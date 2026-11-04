import { z } from 'zod';
import { PLAN_AI_STATUSES, PLAN_METHODS, PLAN_OUTCOMES, PLAN_SOURCES, PROFILE_MODES } from '../enums';
import { IsoDateTimeSchema } from './common';
import { EligibilityAttestationSchema, ProfileSchema } from './onboarding';

export const MacroTargetsSchema = z
  .object({
    energyKcal: z.number().int(),
    proteinG: z.number().int(),
    carbsG: z.number().int(),
    fatG: z.number().int(),
  })
  .meta({ id: 'MacroTargets' });
export type MacroTargets = z.infer<typeof MacroTargetsSchema>;

const RangeSchema = z.object({ min: z.number(), max: z.number() });

export const PlanGoalSchema = z
  .object({
    type: z.string(),
    startWeightKg: z.number().nullable(),
    targetWeightKg: z.number().nullable().describe('Display only (OQ-15, BR-06)'),
    pace: z.literal('gradual').nullable(),
  })
  .meta({ id: 'PlanGoal' });

export const PlanPreviewSchema = z
  .object({
    eligible: z.boolean().describe('True when an energy estimate can be calculated (BR-04)'),
    mode: z.enum(PROFILE_MODES),
    reasons: z.array(z.string()).describe('Why no estimate was produced'),
    method: z.enum(PLAN_METHODS).nullable(),
    inputs: z
      .object({
        ageYears: z.number().int(),
        calculationSex: z.enum(['female', 'male']),
        heightCm: z.number(),
        weightKg: z.number(),
        activityLevel: z.string(),
      })
      .nullable(),
    bmrKcal: z.number().int().nullable(),
    activityFactor: z.number().nullable(),
    tdeeKcal: z.number().int().nullable(),
    adjustmentPct: z.number().nullable(),
    floorKcal: z.number().int().nullable(),
    calculated: MacroTargetsSchema.nullable(),
    bounds: z
      .object({ energyKcal: RangeSchema, proteinG: RangeSchema })
      .nullable()
      .describe('Allowed range for Adjust targets'),
    waterMl: z.number().int(),
    goal: PlanGoalSchema,
  })
  .meta({ id: 'PlanPreview' });
export type PlanPreview = z.infer<typeof PlanPreviewSchema>;

export const PlanPreviewRequestSchema = z
  .strictObject({ eligibility: EligibilityAttestationSchema.optional() })
  .meta({ id: 'PlanPreviewRequest' });
export type PlanPreviewRequest = z.infer<typeof PlanPreviewRequestSchema>;

export const ConfirmPlanRequestSchema = z
  .strictObject({
    source: z.enum(PLAN_SOURCES),
    energyKcal: z.number().int().min(800).max(6000).optional().describe('Required for adjusted and manual'),
    proteinG: z.number().int().min(10).max(500).optional(),
    waterMl: z.number().int().min(500).max(6000).optional(),
    targetWeightKg: z.number().min(20).max(400).nullable().optional(),
    draftId: z.string().regex(/^[a-f0-9]{24}$/).optional().describe('The reviewed draft from POST /plan/generate. Its narrative and time estimate are stored with the plan'),
  })
  .meta({ id: 'ConfirmPlanRequest' });
export type ConfirmPlanRequest = z.infer<typeof ConfirmPlanRequestSchema>;

// ── Plan generation: readiness, draft, timeframe, narrative (PLAN-GEN) ───────────────────────────

export const PlanIssueSchema = z
  .object({
    code: z.string().describe('Stable machine code, e.g. target_above_current'),
    severity: z.enum(['blocking', 'warning']).describe('blocking = no plan until the answers are fixed'),
    message: z.string().describe('Plain-language text, shown as is'),
    questionIds: z.array(z.string()).describe('Answers the user can edit to resolve it'),
  })
  .meta({ id: 'PlanIssue' });
export type PlanIssue = z.infer<typeof PlanIssueSchema>;

export const PlanMissingItemSchema = z
  .object({
    questionId: z.string().describe('Question to answer; "eligibility" for the health check step'),
    field: z.string(),
    reason: z.string().describe('Plain-language text, shown as is'),
  })
  .meta({ id: 'PlanMissingItem' });
export type PlanMissingItem = z.infer<typeof PlanMissingItemSchema>;

export const PlanAssessmentSchema = z
  .object({
    outcome: z.enum(PLAN_OUTCOMES),
    missing: z.array(PlanMissingItemSchema).describe('Essentials for calorie targets that are absent. The AI never guesses these'),
    issues: z.array(PlanIssueSchema),
    guidanceReasons: z.array(z.string()).describe('Why a professional should guide this plan (professional_guidance)'),
    optionalUnanswered: z.array(z.string()).describe('Optional questions that would sharpen the plan'),
    requiredForTargets: z.array(z.string()).describe('Questions a calorie plan needs, in order'),
    canContinueWithoutTargets: z.boolean().describe('Habits-only is available (POST /plan {source:"none"})'),
  })
  .meta({ id: 'PlanAssessment' });
export type PlanAssessment = z.infer<typeof PlanAssessmentSchema>;

export const PlanReadinessSchema = PlanAssessmentSchema.extend({
  inputHash: z.string(),
  attestationOnFile: z.boolean().describe('The health check was answered; do not ask again'),
  attestationNeeded: z.boolean().describe('An estimate is otherwise possible, so the health check step must be shown'),
  latestDraftId: z.string().nullable(),
  latestDraftCurrent: z.boolean().describe('The latest draft was made from the current answers'),
}).meta({ id: 'PlanReadiness' });
export type PlanReadiness = z.infer<typeof PlanReadinessSchema>;

export const PlanTimeframeSchema = z
  .object({
    direction: z.enum(['lose', 'gain']),
    startWeightKg: z.number(),
    targetWeightKg: z.number(),
    changeKg: z.number().describe('Absolute difference'),
    paceKgPerWeek: z.number().describe('Expected rate at the daily target, from its gap to maintenance'),
    estimatedWeeks: z.object({ min: z.number().int(), max: z.number().int() }),
    safeMinWeeks: z.number().int().describe('The fastest this change is planned for automatically (at most 1 kg or 1% of body weight a week for loss, 0.5 kg for gain)'),
    requestedWeeks: z.number().int().nullable().describe('What the user asked for (q35); null when no wish'),
    verdict: z.enum(['no_request', 'realistic', 'faster_than_plan', 'faster_than_safe', 'slower_than_plan']),
    message: z.string().describe('Plain-language text, shown as is. An estimate, never a deadline'),
    rule: z
      .object({ kcalPerKg: z.number(), slowdownFactor: z.number() })
      .describe('Lets the app re-estimate after Adjust targets, in this order: pace = 7 × |maintenanceKcal − targetKcal| ÷ kcalPerKg (kg a week); min = ceil(changeKg ÷ pace); max = ceil(min × slowdownFactor)'),
  })
  .meta({ id: 'PlanTimeframe' });
export type PlanTimeframe = z.infer<typeof PlanTimeframeSchema>;

/** What the model may return. No length or count limits here: strict structured outputs do not honour them; PlanNarrativeSchema enforces them. */
export const PlanNarrativeOutputSchema = z
  .object({
    headline: z.string(),
    summary: z.string(),
    assumptions: z.array(z.string()),
    guidance: z.array(
      z.object({
        title: z.string(),
        body: z.string(),
        area: z.enum(['meals', 'routine', 'activity', 'habits', 'tracking', 'hydration']),
      }),
    ),
    watchOuts: z.array(z.string()),
  });
// No .meta({ id }) here: an id would make the JSON schema a root $ref, which strict structured outputs reject.

export const PLAN_NARRATIVE_LIMITS = { headline: 90, summary: 500, assumption: 180, guidanceBody: 300, watchOut: 200 } as const;

export const PlanNarrativeSchema = z
  .object({
    headline: z.string().trim().min(5).max(PLAN_NARRATIVE_LIMITS.headline),
    summary: z.string().trim().min(20).max(PLAN_NARRATIVE_LIMITS.summary),
    assumptions: z.array(z.string().trim().min(5).max(PLAN_NARRATIVE_LIMITS.assumption)).min(2).max(6),
    guidance: z
      .array(
        z.object({
          title: z.string().trim().min(3).max(60),
          body: z.string().trim().min(20).max(PLAN_NARRATIVE_LIMITS.guidanceBody),
          area: z.enum(['meals', 'routine', 'activity', 'habits', 'tracking', 'hydration']),
        }),
      )
      .min(3)
      .max(6),
    watchOuts: z.array(z.string().trim().min(5).max(PLAN_NARRATIVE_LIMITS.watchOut)).max(3),
  })
  .meta({ id: 'PlanNarrative', description: 'Qualitative AI personalisation. Never contains calorie, macro, weight or time numbers: those come from the validated calculation' });
export type PlanNarrative = z.infer<typeof PlanNarrativeSchema>;

export const PlanAiInfoSchema = z
  .object({
    status: z.enum(PLAN_AI_STATUSES),
    message: z.string().nullable().describe('Shown to the user when status is not ok'),
    retryable: z.boolean().describe('Generate again (regenerate: true) may succeed'),
    model: z.string().nullable(),
  })
  .meta({ id: 'PlanAiInfo' });
export type PlanAiInfo = z.infer<typeof PlanAiInfoSchema>;

export const PlanNoticeSchema = z
  .object({
    kind: z.enum(['professional_guidance', 'habits_only', 'needs_input']),
    title: z.string(),
    body: z.string(),
    reasons: z.array(z.string()),
  })
  .meta({ id: 'PlanNotice', description: 'Static, reviewed copy for outcomes that do not get a calorie plan' });
export type PlanNotice = z.infer<typeof PlanNoticeSchema>;

export const PlanDraftSchema = z
  .object({
    id: z.string(),
    status: z.enum(PLAN_OUTCOMES),
    inputHash: z.string(),
    stale: z.boolean().describe('Answers changed after this draft was made: regenerate before confirming'),
    createdAt: IsoDateTimeSchema,
    assessment: PlanAssessmentSchema,
    preview: PlanPreviewSchema.describe('Validated numbers (eligible=false when status is not ready)'),
    timeframe: PlanTimeframeSchema.nullable(),
    basis: z.array(z.string()).describe('How the estimate works and what it assumes, in plain language'),
    narrative: PlanNarrativeSchema.nullable().describe('null unless ai.status is ok. Never fabricated'),
    ai: PlanAiInfoSchema,
    notice: PlanNoticeSchema.nullable(),
    regenerations: z.number().int().describe('Earlier drafts for these same answers'),
    confirmed: z.boolean(),
    locale: z.string().describe('Language code of every text in this draft (en, bn). Same answers in another language are a new draft'),
  })
  .meta({ id: 'PlanDraft' });
export type PlanDraft = z.infer<typeof PlanDraftSchema>;

export const GeneratePlanRequestSchema = z
  .strictObject({
    eligibility: EligibilityAttestationSchema.optional(),
    regenerate: z.boolean().optional().describe('Ask for a fresh personalisation even though these answers already have one'),
  })
  .meta({ id: 'GeneratePlanRequest' });
export type GeneratePlanRequest = z.infer<typeof GeneratePlanRequestSchema>;

export const PlanSchema = z
  .object({
    id: z.string(),
    version: z.number().int(),
    active: z.boolean(),
    source: z.enum(PLAN_SOURCES),
    energyKcal: z.number().int().nullable(),
    proteinG: z.number().int().nullable(),
    carbsG: z.number().int().nullable(),
    fatG: z.number().int().nullable(),
    waterMl: z.number().int(),
    method: z.enum(PLAN_METHODS).nullable(),
    goal: PlanGoalSchema,
    calculated: MacroTargetsSchema.nullable(),
    confirmedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    draftId: z.string().nullable().describe('The reviewed draft this plan was confirmed from; null for plans made without one'),
    timeframe: PlanTimeframeSchema.nullable().describe('Estimate stored with the plan, re-calculated for the confirmed targets'),
    narrative: PlanNarrativeSchema.nullable(),
    basis: z.array(z.string()),
    ai: PlanAiInfoSchema.nullable(),
    locale: z.string().nullable().describe('Language code of the stored tips and notes; null for plans made without a draft'),
  })
  .meta({ id: 'Plan' });
export type Plan = z.infer<typeof PlanSchema>;

export const CompleteOnboardingResponseSchema = z
  .object({ profile: ProfileSchema, preview: PlanPreviewSchema })
  .meta({ id: 'CompleteOnboardingResponse' });
export type CompleteOnboardingResponse = z.infer<typeof CompleteOnboardingResponseSchema>;
