/**
 * `pnpm env:doctor [--init-secrets] [--ping]`
 * Shows which integrations run for real with the current .env and which still fall back to a stub.
 * Never prints a secret: only set/unset and ok/failed. Everything that is not a secret is an admin
 * setting (admin panel → Settings); --ping lists the ones changed from their defaults.
 * --init-secrets  writes a random value into .env for each of the four secrets that is empty (never overwrites a set one)
 * --ping          opens a connection to MongoDB, reports ok/failed and lists the changed admin settings
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { ConfigError, loadConfig } from '../config/env';
import { SETTING_KEYS } from '../modules/settings/settings.registry';

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

  console.warn(`\nNouri backend: NODE_ENV=${c.NODE_ENV} (one process: API + background jobs, no Redis)\n`);
  row(atlas ? 'real' : 'fake', 'MongoDB', `${atlas ? 'Atlas' : 'local/self-hosted'}, database "${mongoDb || 'test (no name in the URI!)'}"`);
  if (!mongoDb) row('warn', '', 'add /nouri before the "?" in MONGODB_URI, otherwise data is written to the "test" database');
  const missing = SECRETS.filter((k) => !has(k));
  row(missing.length ? 'warn' : 'real', 'Secrets', missing.length ? `public dev defaults in use for ${missing.join(', ')}  →  pnpm env:doctor --init-secrets` : 'JWT, OTP and ledger secrets set');
  row(c.emailDriver === 'resend' ? 'real' : 'fake', 'Email', c.emailDriver === 'resend' ? 'Resend (sender: admin setting email.from)' : 'EMAIL_API_KEY empty: codes are printed in the log, no mail sent');
  row(
    has('GEMINI_API_KEY') ? 'real' : 'warn',
    'AI (Gemini)',
    has('GEMINI_API_KEY')
      ? 'key set: plan tips, coach, live voice and photo scans on; check once with  pnpm plan:smoke  and  pnpm coach:smoke'
      : 'GEMINI_API_KEY empty: plan tips, live voice and photo scans say AI is not switched on',
  );
  row(c.storageDriver === 's3' ? 'real' : 'fake', 'Photo storage', c.storageDriver === 's3' ? 'S3-compatible bucket' : `local disk (${c.LOCAL_STORAGE_DIR}): fine for dev, wiped on every Render deploy`);
  row(has('REVENUECAT_API_KEY') ? 'real' : 'fake', 'Billing', has('REVENUECAT_API_KEY') ? 'RevenueCat verifier' : 'stub store verifier (purchases not checked)');
  row(has('FIREBASE_SERVICE_ACCOUNT_JSON') ? 'real' : 'fake', 'Push (FCM)', has('FIREBASE_SERVICE_ACCOUNT_JSON') ? 'service account set' : 'unset: server reminders are logged, not delivered');
  row(has('PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON') ? 'real' : 'fake', 'Play Integrity', has('PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON') ? 'service account set' : 'unset: Android assertions cannot be verified');
  row(has('TURNSTILE_SECRET') ? 'real' : 'fake', 'Turnstile', has('TURNSTILE_SECRET') ? 'set' : 'unset: any token accepted');
  if (c.devRoutes) row('warn', 'Dev routes', '/v1/dev/* is on: never on a public URL (DEV_ROUTES=false)');
  console.warn('\n  ✔ real   ○ stub/local   ! needs attention');
  console.warn('  Models, scan caps, sign-in client IDs, email sender, integrity and barcode lookups: admin panel → Settings\n');

  if (process.argv.includes('--ping')) {
    try {
      const conn = await mongoose.createConnection(c.MONGODB_URI, { serverSelectionTimeoutMS: 8000 }).asPromise();
      await conn.db!.admin().ping();
      row('real', 'MongoDB', 'connection ok');
      const changed = await conn.db!.collection('app_config').find({ key: { $in: SETTING_KEYS } }, { projection: { key: 1, updatedBy: 1 } }).toArray();
      console.warn(changed.length ? `  Admin settings changed from the defaults: ${changed.map((d) => `${String(d.key)} (by ${String(d.updatedBy ?? '?')})`).join(', ')}` : '  Admin settings: all at their defaults');
      await conn.close();
    } catch (e) {
      row('warn', 'MongoDB', `connection FAILED (${(e as Error).name})`);
      process.exitCode = 1;
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
