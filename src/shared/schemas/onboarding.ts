import { z } from 'zod';
import {
  ACTIVITY_LEVELS,
  ANSWER_STATUSES,
  CALCULATION_SEXES,
  INPUT_METHODS,
  ONBOARDING_ROUTES,
  ONBOARDING_STATUSES,
  PROFILE_MODES,
} from '../enums';
import { IsoDateTimeSchema } from './common';

export const QuestionIdSchema = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Unknown question id');

export const AnswerValueSchema = z
  .union([
    z.string(),
    z.array(z.string()),
    z.number(),
    z.record(z.string(), z.unknown()),
    z.null(),
  ])
  .describe(
    'single: option id; multi/days: option ids; text: string; age: {mode:"dob",dob} | {mode:"age",age} | {mode:"none"}; height: {cm, unit}; weight: {kg, unit, isEstimate}; number: number',
  );
export type AnswerValue = z.infer<typeof AnswerValueSchema>;

/** Statuses a client may write. `not_applicable` is set only by the engine (BR-11). */
export const WRITABLE_ANSWER_STATUSES = ['answered', 'skipped', 'deferred'] as const;

export const AnswerDetailSchema = z
  .strictObject({
    text: z.string().trim().min(1).max(50).optional().describe('Free text for an option with freeText'),
    number: z.number().int().optional().describe('custom number: q33 challenge length, q35 weeks'),
  })
  .meta({ id: 'AnswerDetail' });
export type AnswerDetail = z.infer<typeof AnswerDetailSchema>;

export const AnswerInputSchema = z
  .strictObject({
    questionId: QuestionIdSchema,
    value: AnswerValueSchema.optional(),
    detail: AnswerDetailSchema.optional(),
    status: z.enum(WRITABLE_ANSWER_STATUSES),
    inputMethod: z.enum(INPUT_METHODS),
    answeredAt: IsoDateTimeSchema.optional().describe('Device time the answer was given'),
    questionVersion: z.number().int().min(1).optional(),
  })
  .meta({ id: 'AnswerInput' });
export type AnswerInput = z.infer<typeof AnswerInputSchema>;

export const PutAnswerRequestSchema = AnswerInputSchema.omit({ questionId: true }).meta({
  id: 'PutAnswerRequest',
});
export type PutAnswerRequest = z.infer<typeof PutAnswerRequestSchema>;

export const BulkAnswersRequestSchema = z
  .strictObject({
    route: z.enum(ONBOARDING_ROUTES).optional(),
    answers: z.array(AnswerInputSchema).max(100),
  })
  .meta({ id: 'BulkAnswersRequest' });
export type BulkAnswersRequest = z.infer<typeof BulkAnswersRequestSchema>;

export const SetRouteRequestSchema = z
  .strictObject({ route: z.enum(ONBOARDING_ROUTES) })
  .meta({ id: 'SetRouteRequest' });
export type SetRouteRequest = z.infer<typeof SetRouteRequestSchema>;

export const OnboardingAnswerSchema = z
  .object({
    questionId: z.string(),
    fieldKey: z.string(),
    value: AnswerValueSchema,
    detail: AnswerDetailSchema.nullable(),
    status: z.enum(ANSWER_STATUSES),
    inputMethod: z.enum(INPUT_METHODS),
    questionVersion: z.number().int(),
    answeredAt: IsoDateTimeSchema,
  })
  .meta({ id: 'OnboardingAnswer' });
export type OnboardingAnswer = z.infer<typeof OnboardingAnswerSchema>;

export const OnboardingStateSchema = z
  .object({
    route: z.enum(ONBOARDING_ROUTES),
    status: z.enum(ONBOARDING_STATUSES),
    questionSetVersion: z.number().int(),
    mode: z.enum(PROFILE_MODES),
    answers: z.array(OnboardingAnswerSchema),
    applicableQuestionIds: z.array(z.string()).describe('Ordered questions for the current route'),
    nextQuestionId: z.string().nullable(),
    deferredQuestionIds: z.array(z.string()),
    deferredCount: z.number().int(),
    cleared: z
      .array(z.string())
      .describe('Questions whose stale values this write removed (BR-11)'),
  })
  .meta({ id: 'OnboardingState' });
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export const EligibilityAttestationSchema = z
  .strictObject({
    pregnantOrBreastfeeding: z.boolean(),
    supervisedNutritionCondition: z
      .boolean()
      .describe('A medical condition that needs supervised nutrition'),
    eatingDisorderConcern: z
      .boolean()
      .describe('Has, or has had, an eating disorder, or counting food and weight feels distressing. Required: an answer that was never given is never read as "no"'),
  })
  .meta({ id: 'EligibilityAttestation' });
export type EligibilityAttestation = z.infer<typeof EligibilityAttestationSchema>;

export const CompleteOnboardingRequestSchema = z
  .strictObject({ eligibility: EligibilityAttestationSchema.optional() })
  .meta({ id: 'CompleteOnboardingRequest' });
export type CompleteOnboardingRequest = z.infer<typeof CompleteOnboardingRequestSchema>;

export const ProfileSchema = z
  .object({
    primaryGoal: z.string().nullable(),
    supportingGoals: z.array(z.string()),
    personalMotivation: z.string().nullable(),
    requestedFeatures: z.array(z.string()),
    displayName: z.string().nullable(),
    ageYears: z.number().int().nullable(),
    birthDate: z.string().nullable(),
    calculationSex: z.enum(CALCULATION_SEXES).nullable(),
    heightCm: z.number().nullable(),
    weightKg: z.number().nullable(),
    weightIsEstimate: z.boolean(),
    targetWeightKg: z.number().nullable(),
    activityLevel: z.enum(ACTIVITY_LEVELS).nullable(),
    dietPattern: z.string().nullable(),
    mealSource: z.string().nullable(),
    nutritionFamiliarity: z.string().nullable(),
    startingMood: z.string().nullable(),
    habitPriorities: z.array(z.string()),
    loggingMethods: z.array(z.string()),
    mode: z.enum(PROFILE_MODES),
    eligibility: z.object({
      adult: z.boolean(),
      estimateAllowed: z.boolean(),
      reasons: z.array(z.string()),
    }),
    onboarding: z.object({
      route: z.enum(ONBOARDING_ROUTES),
      status: z.enum(ONBOARDING_STATUSES),
      questionSetVersion: z.number().int(),
      completedAt: IsoDateTimeSchema.nullable(),
      deferredCount: z.number().int(),
    }),
  })
  .meta({ id: 'Profile' });
export type Profile = z.infer<typeof ProfileSchema>;

export const OnboardingQuestionsResponseSchema = z
  .object({
    version: z.number().int(),
    locale: z.string().describe('Language of the texts (en, bn). Requested with ?locale=; falls back to en'),
    questionSet: z.record(z.string(), z.unknown()).describe('Newest question set in the requested language (content/onboarding/questions.vN[.<lang>].json)'),
    conversation: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe('Conversation subset in the same language (content/onboarding/conversation.vN[.<lang>].json)'),
  })
  .meta({ id: 'OnboardingQuestionsResponse' });

export const QuestionSetSchema = z
  .looseObject({
    version: z.number().int(),
    questions: z.array(z.looseObject({ id: z.string(), fieldKey: z.string(), type: z.string() })),
  })
  .meta({ id: 'QuestionSet', description: 'Content of content/onboarding/questions.v1.json' });
