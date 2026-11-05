import { z } from 'zod';
import { knownGeminiPrice } from '../modules/ai/gemini-pricing';

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));
const DEV_SECRET = 'dev-only-secret-change-me-0123456789abcdef';

/** Typed environment, validated at boot (M0-T3). Secrets are required in production. */
export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('0.0.0.0'),
    /** Express `trust proxy`: unset/false = use the socket address; a hop count ("2") or a CIDR list
     * ("173.245.48.0/20,10.0.0.0/8") for Cloudflare + load balancer in production. Never `true`. */
    TRUST_PROXY: z.string().optional(),
    /** Test suites only: multiplies every rate limit (and shortens the OTP resend cooldown). */
    RATE_LIMIT_MULTIPLIER: z.coerce.number().positive().max(10000).default(1),
    DEV_ROUTES: z.enum(['true', 'false', '1', '0']).optional(),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    LOCAL_STORAGE_DIR: z.string().default('.local/uploads'),
    CDN_BASE_URL: z.string().optional(),
    CDN_SIGNING_KEY: z.string().optional(),
    ADMIN_APP_URL: z.string().default('http://localhost:3002'),
    /** api = HTTP only, worker = queue processors only (production), all = both in one process (local development). */
    ROLE: z.enum(['api', 'worker', 'all']).default('api'),
    APP_VERSION: z.string().default('0.1.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    MONGODB_URI: z.string().min(1, 'is required: set it in .env'),
    MONGODB_LAZY: bool(false),
    /** false = admin sign-in skips the TOTP step (development only; refused in production). */
    ADMIN_TOTP_REQUIRED: bool(true),
    REDIS_URL: z.string().optional().transform((v) => (v ? v : undefined)),
    JWT_ACCESS_SECRET: z.string().min(32).default(DEV_SECRET),
    JWT_REFRESH_SECRET: z.string().min(32).default(DEV_SECRET + '-refresh'),
    OTP_PEPPER: z.string().min(16).default(DEV_SECRET + '-otp'),
    LEDGER_PEPPER: z.string().min(16).default(DEV_SECRET + '-ledger'),
    EMAIL_DRIVER: z.enum(['console', 'memory', 'resend']).default('console'),
    EMAIL_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('Nouri <hello@example.com>'),
    /** Development only: every email sign-in code is this value (for example 000000) instead of a random one.
     * Refused in production and together with EMAIL_DRIVER=resend (a known code must never reach real mail). */
    DEV_FIXED_OTP: z.string().regex(/^\d{6}$/, 'must be exactly 6 digits').optional(),
    GOOGLE_CLIENT_IDS: csv,
    APPLE_BUNDLE_ID: z.string().optional(),
    APPLE_SERVICE_ID: z.string().optional(),
    INTEGRITY_DRIVER: z.enum(['allow', 'device']).default('allow'),
    APPLE_APP_ATTEST_TEAM_ID: z.string().optional(),
    APP_ATTEST_ROOT_PEM: z.string().optional().describe('Override of the Apple root (tests only)'),
    APP_ATTEST_ALLOW_DEVELOPMENT: z.enum(['true', 'false']).optional(),
    PLAY_INTEGRITY_PACKAGE: z.string().optional(),
    PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON: z.string().optional(),
    INTEGRITY_ENFORCE: z.enum(['true', 'false', '1', '0']).optional(),
    AI_PROVIDER: z.enum(['fake', 'gemini']).default('fake'),
    /** Monthly spend limit for every AI feature except food photo scans (those have their own daily caps below). */
    AI_MONTHLY_BUDGET_USD: z.coerce.number().positive().optional(),
    /** Model for plan personalisation. Empty = gemini-3.5-flash-lite; the admin setting ai.model.plan wins over it. */
    GEMINI_PLAN_MODEL: z.string().optional(),
    /** Model for the Live voice conversation. Empty = gemini-3.8-live; the admin setting ai.model.realtime wins over it. */
    GEMINI_REALTIME_MODEL: z.string().optional(),
    /** The one Google key for every AI feature. Empty = AI features run on the fake provider and food scans answer AI_UNAVAILABLE (not_configured). */
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_FOOD_MODEL: z.string().default('gemini-3.5-flash-lite'),
    GEMINI_FOOD_THINKING_LEVEL: z.enum(['minimal', 'low', 'medium', 'high']).default('minimal'),
    /** Sets the image token charge on Gemini 3 (about 280 / 560 / 1120), whatever the file size. */
    GEMINI_FOOD_IMAGE_RESOLUTION: z.enum(['low', 'medium', 'high']).default('high'),
    GEMINI_FOOD_IMAGE_MAX_EDGE: z.coerce.number().int().min(512).max(2048).default(1024),
    /** Includes thinking tokens. Measured at about 110 tokens per item, 200 if the model pretty-prints: this fits 15 items either way. */
    GEMINI_FOOD_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(512).max(16384).default(4096),
    GEMINI_FOOD_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(20_000),
    /** Tries per scan, first one included, inside a 38 s budget (the app stops polling at 40 s). */
    GEMINI_FOOD_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
    /** Whole-service limits per UTC day. The app_config key limits.foodScan wins. */
    GEMINI_FOOD_DAILY_REQUEST_CAP: z.coerce.number().int().min(0).default(500),
    GEMINI_FOOD_DAILY_SPEND_USD: z.coerce.number().min(0).default(1),
    /** Prices per million tokens. Needed only for a model not in src/modules/ai/gemini-pricing.ts. */
    GEMINI_FOOD_INPUT_USD_PER_M: z.coerce.number().positive().optional(),
    GEMINI_FOOD_OUTPUT_USD_PER_M: z.coerce.number().positive().optional(),
    /** Development only: canned scan results instead of Gemini, to walk the flow before the key exists. */
    GEMINI_FOOD_MOCK: bool(false),
    FREE_SCANS: z.coerce.number().int().min(0).max(100).default(1),
    CORS_ORIGINS: csv,
    TURNSTILE_SECRET: z.string().optional(),
    REVENUECAT_API_KEY: z.string().optional(),
    FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    REVENUECAT_WEBHOOK_SECRET: z.string().optional(),
    SWAGGER_ENABLED: z.enum(['true', 'false', '1', '0']).optional(),
    CONTENT_DIR: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    SENTRY_DSN: z.string().optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.DEV_FIXED_OTP !== undefined) {
      if (env.NODE_ENV === 'production') ctx.addIssue({ code: 'custom', path: ['DEV_FIXED_OTP'], message: 'not allowed in production' });
      else if (env.EMAIL_DRIVER === 'resend') ctx.addIssue({ code: 'custom', path: ['DEV_FIXED_OTP'], message: 'only with EMAIL_DRIVER=console or memory' });
    }
    if (env.GEMINI_API_KEY && !knownGeminiPrice(env.GEMINI_FOOD_MODEL) && !(env.GEMINI_FOOD_INPUT_USD_PER_M && env.GEMINI_FOOD_OUTPUT_USD_PER_M)) {
      ctx.addIssue({ code: 'custom', path: ['GEMINI_FOOD_MODEL'], message: 'unknown price: set GEMINI_FOOD_INPUT_USD_PER_M and GEMINI_FOOD_OUTPUT_USD_PER_M, or the spending cap cannot work' });
    }
    if (env.NODE_ENV !== 'production') return;
    if (env.GEMINI_FOOD_MOCK) ctx.addIssue({ code: 'custom', path: ['GEMINI_FOOD_MOCK'], message: 'not allowed in production' });
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'OTP_PEPPER', 'LEDGER_PEPPER'] as const) {
      if (env[key].startsWith(DEV_SECRET)) ctx.addIssue({ code: 'custom', path: [key], message: 'required in production' });
    }
    if (!env.REDIS_URL) ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'required in production' });
    if (!env.ADMIN_TOTP_REQUIRED) ctx.addIssue({ code: 'custom', path: ['ADMIN_TOTP_REQUIRED'], message: 'must be true in production' });
    if (env.RATE_LIMIT_MULTIPLIER !== 1) ctx.addIssue({ code: 'custom', path: ['RATE_LIMIT_MULTIPLIER'], message: 'must be 1 in production' });
    if (env.TRUST_PROXY === 'true') ctx.addIssue({ code: 'custom', path: ['TRUST_PROXY'], message: 'use a hop count or CIDR list' });
    if (env.INTEGRITY_DRIVER !== 'device') ctx.addIssue({ code: 'custom', path: ['INTEGRITY_DRIVER'], message: 'must be device in production' });
    if (env.STORAGE_DRIVER !== 's3') ctx.addIssue({ code: 'custom', path: ['STORAGE_DRIVER'], message: 'must be s3 in production' });
    if (env.DEV_ROUTES === 'true' || env.DEV_ROUTES === '1') ctx.addIssue({ code: 'custom', path: ['DEV_ROUTES'], message: 'not allowed in production' });
    if (env.EMAIL_DRIVER !== 'resend') ctx.addIssue({ code: 'custom', path: ['EMAIL_DRIVER'], message: 'must be resend in production' });
    if (!env.TURNSTILE_SECRET) ctx.addIssue({ code: 'custom', path: ['TURNSTILE_SECRET'], message: 'required in production' });
    if (env.AI_PROVIDER === 'fake') ctx.addIssue({ code: 'custom', path: ['AI_PROVIDER'], message: 'fake provider not allowed in production' });
    if (env.AI_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) ctx.addIssue({ code: 'custom', path: ['GEMINI_API_KEY'], message: 'required for gemini' });
  })
  .transform((env) => ({
    ...env,
    corsOrigins: env.CORS_ORIGINS.length
      ? env.CORS_ORIGINS
      : env.NODE_ENV === 'production'
        ? []
        : ['http://localhost:3001', 'http://localhost:3002'],
    isProduction: env.NODE_ENV === 'production',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    /** /v1/dev/* routes (last OTP, local uploads): development only. */
    devRoutes:
      env.NODE_ENV === 'production'
        ? false
        : env.DEV_ROUTES === undefined
          ? env.NODE_ENV === 'development'
          : env.DEV_ROUTES === 'true' || env.DEV_ROUTES === '1',
    integrityEnforced:
      env.INTEGRITY_ENFORCE === undefined
        ? env.NODE_ENV === 'production'
        : env.INTEGRITY_ENFORCE === 'true' || env.INTEGRITY_ENFORCE === '1',
    swaggerEnabled:
      env.SWAGGER_ENABLED === undefined
        ? env.NODE_ENV !== 'production'
        : env.SWAGGER_ENABLED === 'true' || env.SWAGGER_ENABLED === '1',
  }));

export function parseTrustProxy(v: string | undefined): false | number | string[] {
  if (!v || v === 'false' || v === '0') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export type AppConfig = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {}

/** `KEY=` in a .env file is an unset value, not an empty string: it must fall back to the default. */
function dropEmpty(source: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(source).filter(([, v]) => v === undefined || v.trim() !== ''));
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(dropEmpty(source));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid environment:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
