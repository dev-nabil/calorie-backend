/**
 * Stable string IDs shared by the API, web and admin apps.
 * These values are stored in the database; never change an existing value (plan section 6).
 */

export const MEAL_CATEGORIES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type MealCategory = (typeof MEAL_CATEGORIES)[number];

/** `barcode`: a packaged product looked up by its barcode (GET /foods/barcode/{code}). */
export const MEAL_SOURCES = ['photo', 'text', 'voice', 'manual', 'barcode'] as const;
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
/** `professional_guidance` is no longer produced; it stays so older stored drafts still parse. */
export const PLAN_OUTCOMES = ['ready', 'needs_input', 'professional_guidance', 'habits_only'] as const;
export type PlanOutcome = (typeof PLAN_OUTCOMES)[number];

/** State of the AI personalisation of a draft. Only `ok` carries a narrative; nothing is ever invented. */
export const PLAN_AI_STATUSES = ['ok', 'not_configured', 'unavailable', 'invalid_response', 'skipped'] as const;
export type PlanAiStatus = (typeof PLAN_AI_STATUSES)[number];

export const SCAN_STATUSES = ['queued', 'processing', 'succeeded', 'failed', 'rejected'] as const;

/** What a scan photo shows: a served meal (estimated), or the nutrition table on a pack (read as printed). */
export const SCAN_MODES = ['meal', 'label'] as const;
export type ScanMode = (typeof SCAN_MODES)[number];

/** The content/prompts key each scan mode runs on. */
export const scanPromptKey = (mode: ScanMode): 'meal-scan' | 'label-scan' => (mode === 'label' ? 'label-scan' : 'meal-scan');

/** How the values on a nutrition label are given. */
export const LABEL_BASES = ['per_100g', 'per_serving'] as const;
export type LabelBasis = (typeof LABEL_BASES)[number];
export type ScanStatus = (typeof SCAN_STATUSES)[number];

/** How a food was cooked, when the photo shows it. `unknown` never matches a record that needs a specific method. */
export const FOOD_PREPARATIONS = ['boiled', 'steamed', 'fried', 'deep_fried', 'grilled', 'roasted', 'baked', 'curried', 'stewed', 'raw', 'mixed', 'unknown'] as const;
export type FoodPreparation = (typeof FOOD_PREPARATIONS)[number];

/**
 * How processed a food is, judged from what the food is (not from its numbers), so the app can grade the food
 * itself. `whole`: whole or minimally processed foods and home dishes cooked mainly from them; their sugar is
 * natural. `processed`: changed by added sugar, salt, oil or refining, or sugar freed from the fruit (any juice).
 * `ultra_processed`: industrial products with additives (soft drinks, chips, instant noodles, biscuits).
 */
export const FOOD_PROCESSING = ['whole', 'processed', 'ultra_processed'] as const;
export type FoodProcessing = (typeof FOOD_PROCESSING)[number];

/** `mixed_dish` already contains its ingredients; a `component` belongs to one and is not counted again. */
export const FOOD_ROLES = ['single', 'mixed_dish', 'component'] as const;
export type FoodRole = (typeof FOOD_ROLES)[number];

/** What the model says a food is in. It is written before the grams so the weight follows the vessel's real size; never stored. */
export const SCAN_VESSELS = ['plate', 'bowl', 'cup', 'glass', 'pot', 'pan', 'serving_dish', 'tray', 'box', 'hand', 'none'] as const;
export type ScanVessel = (typeof SCAN_VESSELS)[number];

/**
 * `adjusted_estimate`: the user renamed the food and no record matched, so the earlier values were kept.
 * `package_label`: read from the nutrition table printed on the pack. `product_database`: a barcode lookup (Open Food Facts).
 */
export const NUTRITION_SOURCE_TYPES = ['verified_record', 'ai_estimate', 'adjusted_estimate', 'user_entered', 'package_label', 'product_database'] as const;
export type NutritionSourceType = (typeof NUTRITION_SOURCE_TYPES)[number];

/** Nutrients on every item. Anything else appears only when a credible record supplies it. */
export const NUTRIENT_KEYS = ['kcal', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarG', 'sodiumMg'] as const;
export type NutrientKey = (typeof NUTRIENT_KEYS)[number];

export const OTHER_NUTRIENT_KEYS = ['calciumMg', 'ironMg', 'potassiumMg', 'vitaminCMg'] as const;
export type OtherNutrientKey = (typeof OTHER_NUTRIENT_KEYS)[number];

/**
 * Vitamins and minerals a food is a good source of in a normal serving. Named only, never measured: the
 * model knows which foods carry what far better than how much a photo holds, so there are no amounts.
 */
export const RICH_IN_KEYS = ['vitaminA', 'vitaminB12', 'vitaminC', 'vitaminD', 'vitaminE', 'vitaminK', 'folate', 'calcium', 'iron', 'potassium', 'magnesium', 'zinc'] as const;
export type RichInKey = (typeof RICH_IN_KEYS)[number];

/** What a photo produced. `unclear` asks for another photo instead of guessing. */
export const SCAN_OUTCOMES = ['ok', 'no_food', 'unclear'] as const;
export type ScanOutcome = (typeof SCAN_OUTCOMES)[number];

export const RETAKE_REASONS = ['blurry', 'too_dark', 'too_far', 'obstructed'] as const;
export type RetakeReason = (typeof RETAKE_REASONS)[number];

export const SCAN_IMAGE_REJECTIONS = ['unsupported_type', 'corrupt', 'too_large', 'too_small', 'too_many_pixels', 'hash_mismatch'] as const;
export type ScanImageRejection = (typeof SCAN_IMAGE_REJECTIONS)[number];

export const WEIGHT_SOURCES = ['onboarding', 'manual'] as const;
export type WeightSource = (typeof WEIGHT_SOURCES)[number];

export const PROGRESS_RANGES = ['week', 'month', 'quarter'] as const;
export type ProgressRange = (typeof PROGRESS_RANGES)[number];

export const AI_FEATURES = ['vision', 'chat', 'extract', 'tts'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export const MILO_STATES = ['idle', 'listening', 'thinking', 'speaking', 'celebrating'] as const;
export type MiloState = (typeof MILO_STATES)[number];

/** Milo's coaching tone (Plus). `warm` is the default and adds no rule. */
export const COACH_TONES = ['warm', 'cheerful', 'calm', 'direct'] as const;
export type CoachTone = (typeof COACH_TONES)[number];

/** Weekly recap: `last` = the previous Monday–Sunday, `this` = Monday of this week through today (user's timezone). */
export const RECAP_RANGES = ['last', 'this'] as const;
export type RecapRange = (typeof RECAP_RANGES)[number];

/** Milo's face on a recap card (a subset of MILO_STATES). */
export const RECAP_MILO_STATES = ['celebrating', 'speaking', 'thinking', 'idle'] as const;
export type RecapMiloState = (typeof RECAP_MILO_STATES)[number];

/** What a recap card is about; the model picks one per card and it becomes the card id. */
export const RECAP_TOPICS = ['logging', 'meals', 'energy', 'protein', 'water', 'streak', 'favourite', 'next_week'] as const;
export type RecapTopic = (typeof RECAP_TOPICS)[number];
