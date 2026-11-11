import { ConfigError, loadConfig, parseTrustProxy } from './env';

const DB = 'mongodb://example.invalid/nouri';
const s = 'x'.repeat(40);
const PRODUCTION = {
  MONGODB_URI: DB,
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: s,
  JWT_REFRESH_SECRET: s + 'r',
  OTP_PEPPER: s + 'o',
  LEDGER_PEPPER: s + 'l',
  GEMINI_API_KEY: 'test-key',
  EMAIL_API_KEY: 're_test',
  TURNSTILE_SECRET: 't',
  S3_BUCKET: 'nouri',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret',
  CORS_ORIGINS: 'https://a.example, https://b.example',
};

describe('config (M0-T3)', () => {
  it('has safe development defaults', () => {
    const c = loadConfig({ MONGODB_URI: DB });
    expect(c).toMatchObject({ NODE_ENV: 'development', PORT: 3000, swaggerEnabled: true, devRoutes: true, adminTotpRequired: true, emailDriver: 'console', storageDriver: 'local', fakeAi: false });
    expect(c.corsOrigins).toEqual(['http://localhost:3001']);
    expect(c.APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('derives the drivers from the secrets that are set', () => {
    expect(loadConfig({ MONGODB_URI: DB, EMAIL_API_KEY: 'k' }).emailDriver).toBe('resend');
    expect(loadConfig({ MONGODB_URI: DB, S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'i', S3_SECRET_ACCESS_KEY: 's' }).storageDriver).toBe('s3');
    expect(loadConfig({ MONGODB_URI: DB, S3_BUCKET: 'b' }).storageDriver).toBe('local');
    expect(loadConfig({ MONGODB_URI: DB, NODE_ENV: 'test' })).toMatchObject({ emailDriver: 'memory', fakeAi: true, devRoutes: false });
  });

  it('refuses dev secrets and a missing Gemini key in production', () => {
    expect(() => loadConfig({ MONGODB_URI: DB, NODE_ENV: 'production' })).toThrow(ConfigError);
    try {
      loadConfig({ MONGODB_URI: DB, NODE_ENV: 'production' });
    } catch (e) {
      const msg = (e as Error).message;
      for (const k of ['JWT_ACCESS_SECRET', 'GEMINI_API_KEY']) expect(msg).toContain(k);
      for (const k of ['EMAIL_API_KEY', 'TURNSTILE_SECRET', 'S3_BUCKET']) expect(msg).not.toContain(k);
    }
  });

  it('boots in production without email, Turnstile or S3 keys, on the fallbacks', () => {
    const { EMAIL_API_KEY: _e, TURNSTILE_SECRET: _t, S3_BUCKET: _b, S3_ACCESS_KEY_ID: _i, S3_SECRET_ACCESS_KEY: _s, ...bare } = PRODUCTION;
    const c = loadConfig(bare);
    expect(c).toMatchObject({ isProduction: true, adminTotpRequired: true, emailDriver: 'console', storageDriver: 'local' });
    expect(c.TURNSTILE_SECRET).toBeUndefined();
  });

  it('accepts a complete production environment', () => {
    const c = loadConfig(PRODUCTION);
    expect(c).toMatchObject({ isProduction: true, swaggerEnabled: false, devRoutes: false, adminTotpRequired: true, emailDriver: 'resend', storageDriver: 's3', fakeAi: false });
    expect(c.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('parses TRUST_PROXY as off, a hop count or a CIDR list and refuses `true` in production', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('173.245.48.0/20, 10.0.0.0/8')).toEqual(['173.245.48.0/20', '10.0.0.0/8']);
    expect(() => loadConfig({ ...PRODUCTION, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...PRODUCTION, RATE_LIMIT_MULTIPLIER: '10' })).toThrow(/RATE_LIMIT_MULTIPLIER/);
    expect(() => loadConfig({ ...PRODUCTION, DEV_ROUTES: 'true' })).toThrow(/DEV_ROUTES/);
  });

  it('treats empty values (`KEY=` in .env) as unset', () => {
    const c = loadConfig({ MONGODB_URI: DB, JWT_ACCESS_SECRET: '', OTP_PEPPER: '  ', SWAGGER_ENABLED: '', EMAIL_API_KEY: '' });
    expect(c).toMatchObject({ swaggerEnabled: true, emailDriver: 'console' });
    expect(c.JWT_ACCESS_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(() => loadConfig({ ...PRODUCTION, JWT_ACCESS_SECRET: '' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('lets dev turn the admin TOTP step off but never production', () => {
    expect(loadConfig({ MONGODB_URI: DB }).adminTotpRequired).toBe(true);
    expect(loadConfig({ MONGODB_URI: DB, ADMIN_TOTP_REQUIRED: 'false' }).adminTotpRequired).toBe(false);
    expect(() => loadConfig({ ...PRODUCTION, ADMIN_TOTP_REQUIRED: 'false' })).toThrow(/ADMIN_TOTP_REQUIRED/);
  });

  it('lets dev fix the sign-in code to six digits, never in production or with real email', () => {
    expect(loadConfig({ MONGODB_URI: DB }).DEV_FIXED_OTP).toBeUndefined();
    expect(loadConfig({ MONGODB_URI: DB, DEV_FIXED_OTP: '' }).DEV_FIXED_OTP).toBeUndefined();
    expect(loadConfig({ MONGODB_URI: DB, DEV_FIXED_OTP: '000000' }).DEV_FIXED_OTP).toBe('000000');
    expect(() => loadConfig({ MONGODB_URI: DB, DEV_FIXED_OTP: '0000' })).toThrow(/DEV_FIXED_OTP/);
    expect(() => loadConfig({ MONGODB_URI: DB, DEV_FIXED_OTP: 'abcdef' })).toThrow(/DEV_FIXED_OTP/);
    expect(() => loadConfig({ ...PRODUCTION, DEV_FIXED_OTP: '000000' })).toThrow(/DEV_FIXED_OTP/);
    expect(() => loadConfig({ MONGODB_URI: DB, EMAIL_API_KEY: 'k', DEV_FIXED_OTP: '000000' })).toThrow(/DEV_FIXED_OTP/);
  });

  it('rejects invalid values and ignores retired variables', () => {
    expect(() => loadConfig({ MONGODB_URI: DB, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({})).toThrow(/MONGODB_URI/);
    // An old .env (ROLE, REDIS_URL, GEMINI_FOOD_*…) still boots: those are admin settings now.
    expect(() => loadConfig({ MONGODB_URI: DB, ROLE: 'all', REDIS_URL: 'redis://x', GEMINI_FOOD_MODEL: 'x', AI_PROVIDER: 'gemini' })).not.toThrow();
  });
});
