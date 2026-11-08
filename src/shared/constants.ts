/** Defaults from docs/PLAN.md. Runtime values are overridable through app_config. */
export const API_VERSION_PREFIX = 'v1';

export const FREE_SCANS_DEFAULT = 1; // BR-01
export const WATER_STEP_ML = 250; // BR-09
export const WATER_DEFAULT_TARGET_ML = 2500; // BR-05
export const MEAL_RESTORE_WINDOW_DAYS = 7; // BR-17
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // DEC-20
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const DEVICE_INTEGRITY_HEADER = 'X-Device-Integrity';
export const REQUEST_ID_HEADER = 'X-Request-Id';

export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export const DISPLAY_NAME_MAX = 50;
export const MAX_MEAL_ITEMS = 15;
export const ITEM_GRAMS_MIN = 1;
export const ITEM_GRAMS_MAX = 2000;

export const PORTION_MULTIPLIER_PRESETS = [0.5, 1, 1.5] as const;
export const PORTION_MULTIPLIER_MIN = 0.1;
export const PORTION_MULTIPLIER_MAX = 5;

export const SUBSCRIPTION_PRODUCTS = {
  monthly: { productId: 'nouri_plus_monthly', priceUsd: 15 },
  yearly: { productId: 'nouri_plus_yearly', priceUsd: 126 },
} as const;
export const PLUS_ENTITLEMENT_ID = 'plus';

/** Plan generation: successful AI personalisations per user and local day (regenerate button). */
export const PLAN_GENERATIONS_PER_DAY = 6;
/** Hard cap on model calls for plan personalisation per user and local day, whatever their outcome (cost guard). */
export const PLAN_MODEL_ATTEMPTS_PER_DAY = 20;
/** Energy in one kg of body weight change; a rule of thumb, shown to the user as an estimate. */
export const KCAL_PER_KG_BODY_WEIGHT = 7700;

/**
 * AI limits per plan (section 8.9); live values come from app_config. `maxReplyTokens` caps a coach answer, thinking included:
 * a 120-word answer in Bangla or Hindi takes about three times the tokens of the same answer in English.
 */
export const AI_LIMITS = {
  free: { scansLifetime: FREE_SCANS_DEFAULT, describePerDay: 3, coachPerDay: 10, maxReplyTokens: 700, fridgePerDay: 0, recapPerDay: 0 },
  plus: { scansPerDay: 30, scansPerMonthSoft: 200, describePerDay: 50, coachPerDay: 100, maxReplyTokens: 900, fridgePerDay: 5, recapPerDay: 10 },
} as const;

/** Coach style and memory (Plus): at most this many notes, each 1 to COACH_NOTE_MAX_CHARS characters. */
export const COACH_NOTES_MAX = 20;
export const COACH_NOTE_MAX_CHARS = 200;

/** Fridge chef reply sizes (the model is asked for these; the server enforces them). */
export const FRIDGE_MAX_INGREDIENTS = 15;
export const FRIDGE_MAX_IDEAS = 3;
export const FRIDGE_MAX_STEPS = 5;

/** Weekly recap cards: how many, and how long (characters). */
export const RECAP_MIN_CARDS = 3;
export const RECAP_MAX_CARDS = 6;
export const RECAP_TITLE_MAX = 40;
export const RECAP_TEXT_MAX = 160;
