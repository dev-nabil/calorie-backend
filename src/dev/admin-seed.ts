/**
 * `pnpm admin:seed -- --email owner@nouri.dev --password '…' [--role owner]`
 * Creates or resets an admin user and prints a fresh TOTP secret (scan the otpauth URL with an
 * authenticator app). Uses MONGODB_URI from .env (or the environment); there is no local fallback.
 */
import { existsSync } from 'node:fs';
import mongoose from 'mongoose';
import { loadConfig } from '../config/env';
import { ADMIN_ROLES, AdminUserSchema, type AdminRole } from '../modules/admin/admin.schemas';
import { encryptSecret, hashPassword, newTotpSecret, otpauthUrl, totp } from '../modules/admin/admin-crypto';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const email = (arg('email') ?? 'owner@nouri.dev').toLowerCase();
  const password = arg('password') ?? process.env.ADMIN_SEED_PASSWORD;
  const role = (arg('role') ?? 'owner') as AdminRole;
  if (!password || password.length < 12) throw new Error('Pass --password (at least 12 characters) or ADMIN_SEED_PASSWORD');
  if (!ADMIN_ROLES.includes(role)) throw new Error(`--role must be one of ${ADMIN_ROLES.join(', ')}`);
  const config = loadConfig();
  const uri = config.MONGODB_URI;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const Admin = mongoose.model('AdminUser', AdminUserSchema);
  const secret = newTotpSecret();
  await Admin.updateOne(
    { email },
    { $set: { email, role, status: 'active', passwordHash: hashPassword(password), totpSecretEnc: encryptSecret(secret, config.OTP_PEPPER) } },
    { upsert: true },
  );
  await mongoose.disconnect();
  console.warn(
    [
      `Admin ${email} (${role}) is ready in ${uri.replace(/\/\/[^@/]*@/, '//')}.`,
      `TOTP secret: ${secret}`,
      `otpauth URL: ${otpauthUrl(email, secret)}`,
      `Current code (for a quick check): ${totp(secret)}`,
    ].join('\n'),
  );
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
