import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The environment holds only what the process needs before it can read the database, plus secrets:
 * the database URL, keys and passwords, the HTTP binding, storage credentials and development/test
 * switches. Everything else (models, limits, sign-in client IDs, email sender, integrity, barcode
 * lookups…) is an admin setting stored in app_config: see src/modules/settings/settings.registry.ts.
 */

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
/** Unset stays undefined, so the default can depend on NODE_ENV. */
const optionalBool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));
const DEV_SECRET = 'dev-only-secret-change-me-0123456789abcdef';

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Express `trust proxy`: unset = the socket address; a hop count ("1" behind Render) or a CIDR list. Never `true`. */
    TRUST_PROXY: z.string().optional(),
    /** Browser origins allowed to call the API (website and admin panel). Needed before anyone can sign in to change settings. */
    CORS_ORIGINS: csv,

    // ── Database ─────────────────────────────────────────────────────────────
    MONGODB_URI: z.string().min(1, 'is required: set it in .env'),

    // ── Secrets ──────────────────────────────────────────────────────────────
    JWT_ACCESS_SECRET: z.string().min(32).default(DEV_SECRET),
    JWT_REFRESH_SECRET: z.string().min(32).default(DEV_SECRET + '-refresh'),
    /** Also encrypts admin TOTP secrets. */
    OTP_PEPPER: z.string().min(16).default(DEV_SECRET + '-otp'),
    /** HMAC key of the free-scan ledger: never rotate it. */
    LEDGER_PEPPER: z.string().min(16).default(DEV_SECRET + '-ledger'),
    /** The one Google key for every AI feature. Empty (development only) = AI features say they are not switched on. */
    GEMINI_API_KEY: z.string().optional(),
    /** Resend. Empty = no mail is sent, sign-in codes are printed in the log. */
    EMAIL_API_KEY: z.string().optional(),
    /** Cloudflare Turnstile for the waitlist form. Empty = the bot check is off, any token passes. */
    TURNSTILE_SECRET: z.string().optional(),
    /** Server-side purchase checks. Empty = stub verifier. */
    REVENUECAT_API_KEY: z.string().optional(),
    REVENUECAT_WEBHOOK_SECRET: z.string().optional(),
    /** FCM sender. Empty = reminders are logged, not delivered. */
    FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    /** Google Play Integrity decoder. The package name is the admin setting integrity.android.package. */
    PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON: z.string().optional(),

    // ── Photo storage: bucket and both keys set = S3/R2, otherwise local disk (wiped on every Render deploy) ──
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    CDN_BASE_URL: z.string().optional(),
    CDN_SIGNING_KEY: z.string().optional(),
    LOCAL_STORAGE_DIR: z.string().default('.local/uploads'),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

    // ── Development and test switches (each refused or ignored in production) ──
    /** /v1/dev/* (read the last sign-in code, move the clock). Defaults to on in development only. */
    DEV_ROUTES: optionalBool,
    /** /docs and /docs-json. Defaults to on outside production. */
    SWAGGER_ENABLED: optionalBool,
    /** false = admin sign-in skips the TOTP step. */
    ADMIN_TOTP_REQUIRED: optionalBool,
    /** Every email sign-in code is this value. Refused in production and while EMAIL_API_KEY sends real mail. */
    DEV_FIXED_OTP: z.string().regex(/^\d{6}$/, 'must be exactly 6 digits').optional(),
    /** Test suites only: multiplies every rate limit (and shortens the OTP resend cooldown). */
    RATE_LIMIT_MULTIPLIER: z.coerce.number().positive().max(10000).default(1),
    CONTENT_DIR: z.string().optional(),
    /** The openapi script boots without a database. */
    MONGODB_LAZY: optionalBool,
    /** Tests only: replaces the Apple App Attest root certificate. */
    APP_ATTEST_ROOT_PEM: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (env.DEV_FIXED_OTP !== undefined) {
      if (env.NODE_ENV === 'production') issue('DEV_FIXED_OTP', 'not allowed in production');
      else if (env.EMAIL_API_KEY) issue('DEV_FIXED_OTP', 'not allowed while EMAIL_API_KEY sends real mail');
    }
    if (env.NODE_ENV !== 'production') return;
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'OTP_PEPPER', 'LEDGER_PEPPER'] as const) {
      if (env[key].startsWith(DEV_SECRET)) issue(key, 'required in production');
    }
    // EMAIL_API_KEY, TURNSTILE_SECRET and S3_* are optional even in production: each has a working fallback
    // (codes printed in the log, any bot-check token passes, photos on local disk). Only the Gemini key is required.
    if (!env.GEMINI_API_KEY) issue('GEMINI_API_KEY', 'required in production');
    if (env.ADMIN_TOTP_REQUIRED === false) issue('ADMIN_TOTP_REQUIRED', 'must be true in production');
    if (env.DEV_ROUTES) issue('DEV_ROUTES', 'not allowed in production');
    if (env.RATE_LIMIT_MULTIPLIER !== 1) issue('RATE_LIMIT_MULTIPLIER', 'must be 1 in production');
    if (env.TRUST_PROXY === 'true') issue('TRUST_PROXY', 'use a hop count or CIDR list');
  })
  .transform((env) => {
    const isProduction = env.NODE_ENV === 'production';
    const isTest = env.NODE_ENV === 'test';
    return {
      ...env,
      isProduction,
      APP_VERSION: packageVersion(),
      corsOrigins: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : isProduction ? [] : ['http://localhost:3001'],
      trustProxy: parseTrustProxy(env.TRUST_PROXY),
      devRoutes: !isProduction && (env.DEV_ROUTES ?? env.NODE_ENV === 'development'),
      swaggerEnabled: env.SWAGGER_ENABLED ?? !isProduction,
      adminTotpRequired: isProduction || env.ADMIN_TOTP_REQUIRED !== false,
      /** Where sign-in codes go: the in-memory outbox in tests, Resend when a key is set, the log otherwise. */
      emailDriver: isTest ? ('memory' as const) : env.EMAIL_API_KEY ? ('resend' as const) : ('console' as const),
      storageDriver: env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY ? ('s3' as const) : ('local' as const),
      /**
       * Canned AI answers instead of Gemini: tests, plus `pnpm start:local` (QA without a key), which sets it
       * in code. Deliberately not an environment variable, so a deployed server can never fake AI.
       */
      fakeAi: isTest,
    };
  });

export function parseTrustProxy(v: string | undefined): false | number | string[] {
  if (!v || v === 'false' || v === '0') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

let version: string | undefined;
/** The version reported by /v1/health and telemetry comes from package.json, not the environment. */
export function packageVersion(): string {
  if (version) return version;
  try {
    version = (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    version = '0.0.0';
  }
  return version;
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
