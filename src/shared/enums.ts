/**
 * Stable string IDs shared by the API, web and admin apps.
 * These values are stored in the database; never change an existing value (plan section 6).
 */

export const MEAL_CATEGORIES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type MealCategory = (typeof MEAL_CATEGORIES)[number];

export const MEAL_SOURCES = ['photo', 'text', 'voice', 'manual'] as const;
export type MealSource = (typeof MEAL_SOURCES)[number];

export const AUTH_PROVIDERS = ['email', 'google', 'apple'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export const USER_STATUSES = ['active', 'disabled', 'pending_deletion', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ENTITLEMENT_PLANS = ['free', 'plus'] as const;
export type EntitlementPlan = (typeof ENTITLEMENT_PLANS)[number];

export const ENTITLEMENT_PERIODS = ['monthly', 'yearly'] as const;
export type EntitlementPeriod = (typeof ENTITLEMENT_PERIODS)[number];

export const ENTITLEMENT_SOURCES = ['app_store', 'play_store', 'promo'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

export const PLATFORMS = ['ios', 'android', 'web'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ONBOARDING_ROUTES = ['basic', 'detailed', 'conversation'] as const;
export type OnboardingRoute = (typeof ONBOARDING_ROUTES)[number];

export const ONBOARDING_STATUSES = ['in_progress', 'completed'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const ANSWER_STATUSES = ['answered', 'skipped', 'deferred', 'not_applicable'] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

export const INPUT_METHODS = ['form', 'chip', 'typed', 'voice'] as const;
export type InputMethod = (typeof INPUT_METHODS)[number];

/** Activity levels used by the plan calculator (BR-04). */
/** q10 option ids that carry an activity factor (OQ-27: 'intense' is stored; 'unsure' = no estimate). */
export const ACTIVITY_LEVELS = ['seated', 'light', 'active', 'intense'] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

export const CALCULATION_SEXES = ['female', 'male'] as const;
export type CalculationSex = (typeof CALCULATION_SEXES)[number];

export const PROFILE_MODES = ['full', 'habits_only'] as const;
export type ProfileMode = (typeof PROFILE_MODES)[number];

export const PLAN_SOURCES = ['calculated', 'adjusted', 'manual', 'none'] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];

export const PLAN_METHODS = ['mifflin_st_jeor_v1'] as const;
export type PlanMethod = (typeof PLAN_METHODS)[number];

/** Result of the plan assessment (plan section 10, PLAN-GEN): what the user can be offered right now. */
export const PLAN_OUTCOMES = ['ready', 'needs_input', 'professional_guidance', 'habits_only'] as const;
export type PlanOutcome = (typeof PLAN_OUTCOMES)[number];

/** State of the AI personalisation of a draft. Only `ok` carries a narrative; nothing is ever invented. */
export const PLAN_AI_STATUSES = ['ok', 'not_configured', 'unavailable', 'invalid_response', 'skipped'] as const;
export type PlanAiStatus = (typeof PLAN_AI_STATUSES)[number];

export const SCAN_STATUSES = ['queued', 'processing', 'succeeded', 'failed', 'rejected'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const WEIGHT_SOURCES = ['onboarding', 'manual'] as const;
export type WeightSource = (typeof WEIGHT_SOURCES)[number];

export const PROGRESS_RANGES = ['week', 'month', 'quarter'] as const;
export type ProgressRange = (typeof PROGRESS_RANGES)[number];

export const AI_FEATURES = ['vision', 'chat', 'extract', 'tts'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export const MILO_STATES = ['idle', 'listening', 'thinking', 'speaking', 'celebrating'] as const;
export type MiloState = (typeof MILO_STATES)[number];
