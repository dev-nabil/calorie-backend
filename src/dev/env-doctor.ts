/**
 * `pnpm env:doctor [--init-secrets] [--ping]`
 * Shows which integrations run for real with the current .env and which still fall back to a fake or stub.
 * Never prints a value: only driver names, set/unset and ok/failed.
 * --init-secrets  writes a random value into .env for each of the four secrets that is empty (never overwrites a set one)
 * --ping          opens a connection to MongoDB and Redis and reports ok/failed
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import { ConfigError, loadConfig } from '../config/env';

const ENV_FILE = '.env';
const SECRETS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'OTP_PEPPER', 'LEDGER_PEPPER'] as const;

type Status = 'real' | 'fake' | 'warn';
const MARK: Record<Status, string> = { real: '✔', fake: '○', warn: '!' };
const row = (status: Status, name: string, detail: string): void => console.warn(`  ${MARK[status]} ${name.padEnd(14)} ${detail}`);

/** Fills the empty secrets in .env in place, keeping comments and order. Returns the keys it wrote. */
function initSecrets(): string[] {
  if (!existsSync(ENV_FILE)) throw new Error('.env not found: run  cp .env.example .env  first');
  const written: string[] = [];
  let text = readFileSync(ENV_FILE, 'utf8');
  for (const key of SECRETS) {
    const line = new RegExp(`^${key}=([^#\\n]*?)(\\s*#.*)?$`, 'm');
    const m = line.exec(text);
    if (m && m[1]?.trim()) continue;
    const value = randomBytes(32).toString('hex');
    if (m) text = text.replace(line, (_all, _v, comment: string | undefined) => `${key}=${value}${comment ?? ''}`);
    else text += `${text.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
    written.push(key);
  }
  if (written.length) writeFileSync(ENV_FILE, text);
  return written;
}

async function ping(name: string, probe: () => Promise<unknown>): Promise<void> {
  try {
    await probe();
    row('real', name, 'connection ok');
  } catch (e) {
    row('warn', name, `connection FAILED (${(e as Error).name})`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--init-secrets')) {
    const written = initSecrets();
    console.warn(written.length ? `Wrote ${written.join(', ')} to ${ENV_FILE} (values not shown).` : 'All four secrets already set, nothing written.');
  }
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

  const c = loadConfig();
  const env = process.env;
  const has = (k: string): boolean => Boolean(env[k]?.trim());
  const mongoDb = (() => {
    try {
      return new URL(c.MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.replace(/^\//, '');
    } catch {
      return '';
    }
  })();
  const atlas = c.MONGODB_URI.startsWith('mongodb+srv://');

  console.warn(`\nNouri backend: NODE_ENV=${c.NODE_ENV}, ROLE=${c.ROLE}\n`);
  row(atlas ? 'real' : 'fake', 'MongoDB', `${atlas ? 'Atlas' : 'local/self-hosted'}, database "${mongoDb || 'test (no name in the URI!)'}"`);
  if (!mongoDb) row('warn', '', 'add /nouri before the "?" in MONGODB_URI, otherwise data is written to the "test" database');
  row(c.REDIS_URL ? 'real' : 'fake', 'Redis', c.REDIS_URL ? 'set (BullMQ worker and shared state on)' : 'unset: in-memory store, scans run inline');
  const missing = SECRETS.filter((k) => !has(k));
  row(missing.length ? 'warn' : 'real', 'Secrets', missing.length ? `public dev defaults in use for ${missing.join(', ')}  →  pnpm env:doctor --init-secrets` : 'JWT, OTP and ledger secrets set');
  const resendOk = c.EMAIL_DRIVER === 'resend' && has('EMAIL_API_KEY');
  row(resendOk ? 'real' : c.EMAIL_DRIVER === 'resend' ? 'warn' : 'fake', 'Email', resendOk ? `Resend, from ${c.EMAIL_FROM.replace(/^.*</, '<')}` : c.EMAIL_DRIVER === 'resend' ? 'EMAIL_DRIVER=resend but EMAIL_API_KEY is empty' : `${c.EMAIL_DRIVER}: codes are printed, no mail sent`);
  const aiOk = c.AI_PROVIDER === 'openai' && has('OPENAI_API_KEY');
  row(aiOk ? 'real' : c.AI_PROVIDER === 'openai' ? 'warn' : 'fake', 'AI', aiOk ? 'OpenAI' : c.AI_PROVIDER === 'openai' ? 'AI_PROVIDER=openai but OPENAI_API_KEY is empty: silently falls back to the fake provider' : 'fake provider (canned scan/parse results; plan tips are off, never faked)');
  row(
    aiOk ? 'real' : 'warn',
    'Plan tips',
    aiOk
      ? `personalised plan wording on, model ${c.OPENAI_PLAN_MODEL || 'gpt-5-mini (default)'}; verify once with  pnpm plan:smoke`
      : 'off: plans still get validated calorie and macro targets, but no personalised tips (the app says so)',
  );
  row(
    aiOk ? 'real' : 'warn',
    'Live voice',
    aiOk ? `Milo talks over OpenAI Realtime, model ${c.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1 (default)'}; the phone connects to OpenAI directly with a minted secret` : 'off: needs AI_PROVIDER=openai and OPENAI_API_KEY; the app falls back to typing, chips and on-device voice',
  );
  if (aiOk && !c.OPENAI_MONTHLY_BUDGET_USD) row('warn', '', 'no OPENAI_MONTHLY_BUDGET_USD: set one, or set the budget in the admin panel (AI → Settings)');
  row(has('GOOGLE_CLIENT_IDS') ? 'real' : 'fake', 'Google sign-in', has('GOOGLE_CLIENT_IDS') ? `${c.GOOGLE_CLIENT_IDS.length} client ID(s)` : 'GOOGLE_CLIENT_IDS empty: Google sign-in fails');
  row(has('APPLE_BUNDLE_ID') || has('APPLE_SERVICE_ID') ? 'real' : 'fake', 'Apple sign-in', has('APPLE_BUNDLE_ID') || has('APPLE_SERVICE_ID') ? 'audience set' : 'APPLE_BUNDLE_ID / APPLE_SERVICE_ID empty: Apple sign-in fails');
  const s3Ok = c.STORAGE_DRIVER === 's3' && ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].every(has);
  row(s3Ok ? 'real' : c.STORAGE_DRIVER === 's3' ? 'warn' : 'fake', 'Photo storage', s3Ok ? 'S3-compatible bucket' : c.STORAGE_DRIVER === 's3' ? 'STORAGE_DRIVER=s3 but bucket or keys are empty' : `local disk (${c.LOCAL_STORAGE_DIR}): fine for dev`);
  row(has('REVENUECAT_API_KEY') ? 'real' : 'fake', 'Billing', has('REVENUECAT_API_KEY') ? 'RevenueCat verifier' : 'stub store verifier (purchases not checked)');
  row(has('FIREBASE_SERVICE_ACCOUNT_JSON') ? 'real' : 'fake', 'Push (FCM)', has('FIREBASE_SERVICE_ACCOUNT_JSON') ? 'service account set' : 'unset: reminders are not delivered');
  row(c.INTEGRITY_DRIVER === 'device' ? 'real' : 'fake', 'Integrity', `${c.INTEGRITY_DRIVER}, enforce=${c.integrityEnforced}`);
  row(has('TURNSTILE_SECRET') ? 'real' : 'fake', 'Turnstile', has('TURNSTILE_SECRET') ? 'set' : 'unset: any token accepted');
  console.warn('\n  ✔ real   ○ fake/stub/local   ! needs attention\n');

  if (process.argv.includes('--ping')) {
    await ping('MongoDB', async () => {
      const conn = await mongoose.createConnection(c.MONGODB_URI, { serverSelectionTimeoutMS: 8000 }).asPromise();
      await conn.db!.admin().ping();
      await conn.close();
    });
    if (c.REDIS_URL) {
      const redis = new Redis(c.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true, retryStrategy: () => null });
      redis.on('error', () => undefined);
      await ping('Redis', async () => {
        await redis.connect();
        await redis.ping();
      });
      redis.disconnect();
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
