import type { ErrorCode } from '../errors';
import type { ErrMsg, Msg } from './types';

/**
 * English server texts (the reference catalog). Every key must exist in every other language: the
 * compiler enforces it (`Record<MessageKey, Msg>` in each catalog) and a test checks the values.
 * Numbers arrive as ASCII; the app shows them in the user's numerals.
 */
export const en = {
  // ── Plan: what is missing / contradictory ──
  'plan.missing.age': 'Your age tells us which features are right for you. Add it, or continue with habits only.',
  'plan.missing.sex': 'The calorie equation needs a sex input. Add it, or continue with habits only.',
  'plan.missing.height': 'Your height is needed for the calorie equation.',
  'plan.missing.weight': 'Your current weight is needed for the calorie equation.',
  'plan.missing.activity': 'Pick the movement level closest to a normal week. "Not sure" cannot be used for an estimate.',
  'plan.missing.eligibility': 'A short health check comes before any calorie estimate.',
  'plan.issue.bmi_implausible': 'That height and weight look unlikely together. Please check both, including the unit.',
  'plan.issue.target_equals_current': 'Your target is the same as your current weight. Choose a different target, or leave it blank.',
  'plan.issue.target_above_current': 'Your target is above your current weight, but your goal is weight loss. Change the target or the goal.',
  'plan.issue.target_below_current': 'Your target is below your current weight, but your goal is weight gain. Change the target or the goal.',
  'plan.issue.target_bmi_low': 'That target would be below the healthy weight range for your height. Choose a higher target, or leave it blank.',
  'plan.issue.large_change': 'That is a big change. It can help to aim for a smaller first target and revisit it.',
  'plan.issue.allergies_unknown': 'You have not told us about food allergies or intolerances, so ideas are not filtered for them. You can add them now.',
  'plan.issue.weight_is_estimate': 'Your weight is an estimate, so your targets are too. Update it when you can.',
  // ── Plan: notices for outcomes without a calorie plan ──
  'plan.notice.eating_disorder_concern.title': 'Support first, numbers later',
  'plan.notice.eating_disorder_concern.body':
    'Counting food and weight is not always helpful, so I will not set calorie or weight targets. If eating feels hard right now, talking to your GP or an eating disorder support service can really help. I can still help with meals, water and routine.',
  'plan.notice.pregnant_or_breastfeeding.title': 'A professional is the best guide here',
  'plan.notice.pregnant_or_breastfeeding.body':
    'Your energy needs change during pregnancy and while breastfeeding, so I will not set a calorie target. Your midwife, GP or a registered dietitian can set one safely. I can still help with meals, water and routine.',
  'plan.notice.supervised_condition.title': 'A professional is the best guide here',
  'plan.notice.supervised_condition.body':
    'When a health professional guides what you eat, any calorie target should come from them, so I will not set one. I can still help with meals, water and routine.',
  'plan.notice.underweight_loss_goal.title': 'Let us check this together',
  'plan.notice.underweight_loss_goal.body':
    'Based on the height and weight you gave, losing weight may not be right for you, so I will not set a weight-loss plan. A GP or dietitian can look at this with you. If a number is wrong, you can edit your answers. I can still help with meals, water and routine.',
  'plan.notice.habits_only.title': 'Let us focus on habits',
  'plan.notice.habits_only.body':
    'At your age, Nouri focuses on regular meals, water and routine rather than calorie numbers. A parent, carer or health professional can help with anything beyond that.',
  'plan.notice.needs_input.blocking.title': 'Something needs a second look',
  'plan.notice.needs_input.blocking.body':
    'Some of your answers do not fit together. I will not guess which one is right, so please check them. You can also continue with habits only.',
  'plan.notice.needs_input.missing.title': 'A few details are missing',
  'plan.notice.needs_input.missing.body': 'I need these to work out a calorie estimate, and I will not guess them. You can add them now or continue with habits only.',
  // ── Plan: time estimate ──
  'plan.verb.lose.ing': 'losing',
  'plan.verb.gain.ing': 'gaining',
  'plan.verb.lose.noun': 'losing',
  'plan.verb.gain.noun': 'gaining',
  'plan.duration': (p) => {
    const n = Number(p.n);
    const unit = p.unit === 'weeks' ? 'week' : p.unit === 'months' ? 'month' : 'year';
    return `${p.n} ${unit}${n === 1 ? '' : 's'}`;
  },
  'plan.range.same': (p) => `about ${p.a} to ${p.b}`,
  'plan.range.single': (p) => `about ${p.a}`,
  'plan.timeframe.no_request': (p) => `At this pace, ${p.verb} ${p.change} kg could take ${p.eta}. That is an estimate, not a deadline, and progress is never a straight line.`,
  'plan.timeframe.faster_than_safe': (p) =>
    `${p.req} would mean ${p.verb} more than about ${p.maxPace} kg a week, which is faster than I plan for. A steadier plan takes at least ${p.safeMin}, and at this pace you can expect ${p.eta}. Please allow more time or choose a smaller target.`,
  'plan.timeframe.faster_than_plan': (p) =>
    `At this steady pace, ${p.verb} ${p.change} kg would take ${p.eta}, longer than the ${p.req} you hoped for. I do not push harder than this automatically. You can allow more time, choose a smaller target, or adjust the targets yourself within the safe limits.`,
  'plan.timeframe.realistic': (p) => `Your ${p.req} fits this pace: ${p.verb} ${p.change} kg could take ${p.eta}. That is an estimate, not a deadline.`,
  'plan.timeframe.slower_than_plan': (p) => `You have allowed ${p.req}, which is longer than the ${p.eta} this pace needs. That is fine: there is no rush.`,
  // ── Plan: how the numbers were made ──
  'plan.activity.seated': 'mostly seated',
  'plan.activity.light': 'lightly active',
  'plan.activity.active': 'active',
  'plan.activity.intense': 'very active',
  'plan.basis.resting': (p) =>
    `Your resting energy (about ${p.bmr} kcal) comes from the Mifflin-St Jeor equation, using your age, height, weight and sex input. Because you are ${p.activity}, we multiplied it by ${p.factor} to estimate what you use in a day: about ${p.tdee} kcal.`,
  'plan.basis.below': (p) => `Your daily target is ${p.pct}% below that, a gentle gap that is meant to be sustainable.`,
  'plan.basis.above': (p) => `Your daily target is ${p.pct}% above that, a gentle surplus that is meant to be sustainable.`,
  'plan.basis.matches': 'Your daily target matches that estimate, so it is meant to hold your weight steady.',
  'plan.basis.adjusted': (p) => `You adjusted your daily target to ${p.kcal} kcal. The calculation above is where it started from.`,
  'plan.basis.floor': (p) => `Targets never go below ${p.floor} kcal a day.`,
  'plan.basis.macros': 'Protein is set at 1.6 g per kg of body weight (kept between 15% and 30% of energy), fat at 27% of energy, and carbohydrate makes up the rest.',
  'plan.basis.estimates': 'These are estimates. People differ by 10% or more, so treat the first two weeks as a trial and adjust if you feel hungry, tired or are not seeing a trend.',
  'plan.basis.weightEstimate': 'You gave your weight as an estimate, so every number here is a little less certain.',
  'plan.basis.allergiesUnknown': 'You have not told us about food allergies or intolerances, so ideas are not filtered for them.',
  'plan.basis.timeframe': (p) => `Time estimates assume about ${p.kcalPerKg} kcal per kg of body weight change and allow for progress slowing down. They are a guide, not a deadline.`,
  // ── Plan: AI status and service messages ──
  'plan.ai.not_configured': 'Personalised tips are not switched on yet. Your numbers are ready, and the tips can be added later.',
  'plan.ai.unavailable': 'Milo is resting, so your personalised tips are not ready. Your numbers are fine. Try again in a moment.',
  'plan.ai.invalid_response': 'The personalised tips did not come out right this time. Your numbers are fine. You can try again.',
  'plan.ai.skipped_unverified': 'Verify your email to get personalised tips. Your numbers are ready.',
  'plan.ai.limit_today': "You have reached today's limit for personalised tips. Your numbers are ready, and the tips can be tried again tomorrow.",
  'plan.ai.refresh_limit': 'You have refreshed your plan many times today. Confirm the one you have, or try again tomorrow.',
  'plan.ai.attempts_cap': 'Too many attempts today. Your numbers are ready; try the tips again tomorrow.',
  // ── E-mail ──
  'email.otp.subject': (p) => `${p.code} is your Nouri code`,
  'email.otp.body': (p) => `Your Nouri sign-in code is ${p.code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
} satisfies Record<string, Msg>;

export type MessageKey = keyof typeof en;

/** Generic message per error code, used for non-English requests. English requests keep the specific message the code raised. */
export const enErrors: Record<ErrorCode, ErrMsg> = {
  VALIDATION_FAILED: 'Some of the details are not valid. Please check them and try again.',
  BAD_REQUEST: 'That request could not be understood.',
  NOT_FOUND: 'We could not find that.',
  CONFLICT: 'That conflicts with something that changed. Please try again.',
  VERSION_CONFLICT: 'This was changed elsewhere. Reload and try again.',
  INTERNAL: 'Something went wrong on our side. Please try again.',
  SERVICE_UNAVAILABLE: 'The service is busy right now. Please try again soon.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  UNAUTHENTICATED: 'Please sign in.',
  TOKEN_EXPIRED: 'Your session has expired. Please sign in again.',
  TOKEN_REVOKED: 'You were signed out. Please sign in again.',
  REFRESH_TOKEN_REUSED: 'For your safety you were signed out. Please sign in again.',
  FORBIDDEN: 'You are not allowed to do that.',
  ACCOUNT_DISABLED: 'This account is disabled.',
  ACCOUNT_DELETED: 'This account is being deleted.',
  EMAIL_NOT_VERIFIED: 'Verify your email to use this.',
  DISPOSABLE_EMAIL: 'Please use a permanent email address.',
  OTP_INVALID: 'That code is not right. Check it and try again.',
  OTP_EXPIRED: 'That code has expired. Ask for a new one.',
  OTP_TOO_MANY_ATTEMPTS: 'Too many wrong codes. Ask for a new one later.',
  PROVIDER_TOKEN_INVALID: 'We could not verify that sign-in. Please try again.',
  ACCOUNT_LINK_REQUIRED: 'This email already has an account. Sign in the way you used before to link them.',
  INTEGRITY_REQUIRED: 'This device could not be verified.',
  INTEGRITY_INVALID: 'This device could not be verified.',
  IDEMPOTENCY_KEY_REQUIRED: 'The request is missing its safety key.',
  IDEMPOTENCY_KEY_REUSED: 'That request was already used with different details.',
  IDEMPOTENCY_IN_PROGRESS: 'That request is still being processed.',
  QUESTION_NOT_FOUND: 'We could not find that question.',
  ANSWER_INVALID: 'That answer is not valid.',
  ANSWER_REQUIRED: 'Please answer this question first.',
  QUESTION_NOT_APPLICABLE: 'That question does not apply to you.',
  PLAN_NOT_ELIGIBLE: 'Energy targets are not available for this profile.',
  PLAN_OUT_OF_BOUNDS: (d) => `That target is outside the allowed range${d.min !== undefined && d.max !== undefined ? ` (${d.min} to ${d.max})` : ''}.`,
  PLAN_NOT_FOUND: 'No plan has been confirmed yet.',
  PLAN_DRAFT_NOT_FOUND: 'That plan could not be found. Prepare it again.',
  PLAN_DRAFT_STALE: 'Your answers changed after this plan was prepared. Prepare it again before confirming.',
  PLAN_GENERATION_IN_PROGRESS: 'Your plan is already being prepared. Give it a moment.',
  MEAL_NOT_FOUND: 'We could not find that meal.',
  MEAL_RESTORE_EXPIRED: 'This meal can no longer be restored.',
  INVALID_DAY_KEY: 'That date is not valid.',
  INVALID_TIMEZONE: 'That time zone is not valid.',
  SCAN_LIMIT_REACHED: 'You have used your free scans.',
  SCAN_NOT_FOUND: 'We could not find that scan.',
  SCAN_CONFLICT: 'That scan is already being processed.',
  AI_UNAVAILABLE: 'Milo is resting. Try again soon.',
  AI_LIMIT_REACHED: 'Daily limit reached. Try again tomorrow.',
  CONVERSATION_NOT_FOUND: 'We could not find that conversation.',
  NOTHING_TO_CONFIRM: 'There is nothing to confirm.',
  INPUT_FLAGGED: 'I cannot help with that message.',
  PLUS_REQUIRED: 'This is part of Plus.',
  FEATURE_DISABLED: 'This feature is not available right now.',
};
