import { ConfigError, loadConfig, parseTrustProxy } from './env';
import { MemoryKvStore } from '../infra/kv/kv-store';

const DB = 'mongodb://example.invalid/nouri';

describe('config (M0-T3)', () => {
  it('has safe development defaults', () => {
    const c = loadConfig({ MONGODB_URI: DB });
    expect(c).toMatchObject({ NODE_ENV: 'development', ROLE: 'api', PORT: 3000, integrityEnforced: false, swaggerEnabled: true, FREE_SCANS: 1 });
    expect(c.corsOrigins).toEqual(['http://localhost:3001', 'http://localhost:3002']);
  });

  it('refuses dev secrets, missing Redis, console email and the fake AI in production', () => {
    expect(() => loadConfig({ MONGODB_URI: DB, NODE_ENV: 'production' })).toThrow(ConfigError);
    try {
      loadConfig({ MONGODB_URI: DB, NODE_ENV: 'production' });
    } catch (e) {
      const msg = (e as Error).message;
      for (const k of ['JWT_ACCESS_SECRET', 'REDIS_URL', 'EMAIL_DRIVER', 'AI_PROVIDER', 'TURNSTILE_SECRET']) expect(msg).toContain(k);
    }
  });

  it('accepts a complete production environment and enforces integrity', () => {
    const s = 'x'.repeat(40);
    const c = loadConfig({
      MONGODB_URI: DB,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: s,
      JWT_REFRESH_SECRET: s + 'r',
      OTP_PEPPER: s + 'o',
      LEDGER_PEPPER: s + 'l',
      REDIS_URL: 'redis://r:6379',
      EMAIL_DRIVER: 'resend',
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-key',
      TURNSTILE_SECRET: 't',
      STORAGE_DRIVER: 's3',
      INTEGRITY_DRIVER: 'device',
      CORS_ORIGINS: 'https://a.example, https://b.example',
    });
    expect(c).toMatchObject({ integrityEnforced: true, swaggerEnabled: false, corsOrigins: ['https://a.example', 'https://b.example'] });
  });

  it('parses TRUST_PROXY as off, a hop count or a CIDR list and refuses `true` in production', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('173.245.48.0/20, 10.0.0.0/8')).toEqual(['173.245.48.0/20', '10.0.0.0/8']);
    expect(() => loadConfig({ MONGODB_URI: DB, NODE_ENV: 'production', TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ MONGODB_URI: DB, NODE_ENV: 'production', RATE_LIMIT_MULTIPLIER: '10' })).toThrow(/RATE_LIMIT_MULTIPLIER/);
  });

  it('treats empty values (`KEY=` in .env) as unset', () => {
    const c = loadConfig({ MONGODB_URI: DB, JWT_ACCESS_SECRET: '', OTP_PEPPER: '  ', INTEGRITY_ENFORCE: '', SWAGGER_ENABLED: '', AI_MONTHLY_BUDGET_USD: '', REDIS_URL: '' });
    expect(c).toMatchObject({ integrityEnforced: false, swaggerEnabled: true });
    expect(c.REDIS_URL).toBeUndefined();
    expect(c.AI_MONTHLY_BUDGET_USD).toBeUndefined();
    expect(c.JWT_ACCESS_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(() => loadConfig({ MONGODB_URI: DB, NODE_ENV: 'production', JWT_ACCESS_SECRET: '' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('lets dev turn the admin TOTP step off but never production', () => {
    expect(loadConfig({ MONGODB_URI: DB }).ADMIN_TOTP_REQUIRED).toBe(true);
    expect(loadConfig({ MONGODB_URI: DB, ADMIN_TOTP_REQUIRED: 'false' }).ADMIN_TOTP_REQUIRED).toBe(false);
    expect(() => loadConfig({ MONGODB_URI: DB, NODE_ENV: 'production', ADMIN_TOTP_REQUIRED: 'false' })).toThrow(/ADMIN_TOTP_REQUIRED/);
  });

  it('lets dev fix the sign-in code to six digits, never in production or with real email', () => {
    expect(loadConfig({ MONGODB_URI: DB }).DEV_FIXED_OTP).toBeUndefined();
    expect(loadConfig({ MONGODB_URI: DB, DEV_FIXED_OTP: '' }).DEV_FIXED_OTP).toBeUndefined();
    expect(loadConfig({ MONGODB_URI: DB, DEV_FIXED_OTP: '000000' }).DEV_FIXED_OTP).toBe('000000');
    expect(() => loadConfig({ MONGODB_URI: DB, DEV_FIXED_OTP: '0000' })).toThrow(/DEV_FIXED_OTP/);
    expect(() => loadConfig({ MONGODB_URI: DB, DEV_FIXED_OTP: 'abcdef' })).toThrow(/DEV_FIXED_OTP/);
    expect(() => loadConfig({ MONGODB_URI: DB, NODE_ENV: 'production', DEV_FIXED_OTP: '000000' })).toThrow(/DEV_FIXED_OTP/);
    expect(() => loadConfig({ MONGODB_URI: DB, EMAIL_DRIVER: 'resend', EMAIL_API_KEY: 'k', DEV_FIXED_OTP: '000000' })).toThrow(/DEV_FIXED_OTP/);
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ MONGODB_URI: DB, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ MONGODB_URI: DB, ROLE: 'cron' })).toThrow(/ROLE/);
    expect(loadConfig({ MONGODB_URI: DB, ROLE: 'all' }).ROLE).toBe('all');
    expect(() => loadConfig({})).toThrow(/MONGODB_URI/);
  });
});

describe('MemoryKvStore', () => {
  it('expires keys, counts and supports set-if-absent', async () => {
    let now = 0;
    const kv = new MemoryKvStore(() => now);
    expect(await kv.setIfAbsent('a', '1', 10)).toBe(true);
    expect(await kv.setIfAbsent('a', '2', 10)).toBe(false);
    expect(await kv.incr('c', 60)).toEqual({ count: 1, ttlSec: 60 });
    now = 30_000;
    expect(await kv.incr('c', 60)).toEqual({ count: 2, ttlSec: 30 });
    expect(await kv.get('a')).toBeNull();
    await kv.del('c');
    expect(await kv.get('c')).toBeNull();
    expect(await kv.ping()).toBe(true);
  });

  describe('Gemini food scanner', () => {
    const dev = { NODE_ENV: 'development', MONGODB_URI: 'mongodb://x/y' };
    it('defaults to the cheap Flash-Lite model at the lowest thinking level, with caps on', () => {
      expect(loadConfig(dev)).toMatchObject({
        GEMINI_FOOD_MODEL: 'gemini-3.5-flash-lite',
        GEMINI_FOOD_THINKING_LEVEL: 'minimal',
        GEMINI_FOOD_MOCK: false,
        GEMINI_FOOD_DAILY_REQUEST_CAP: 500,
        GEMINI_FOOD_DAILY_SPEND_USD: 1,
      });
    });
    it('refuses a model it cannot price, because the spending cap would not work', () => {
      expect(() => loadConfig({ ...dev, GEMINI_API_KEY: 'k', GEMINI_FOOD_MODEL: 'gemini-9-ultra' })).toThrow(/GEMINI_FOOD_MODEL/);
      expect(loadConfig({ ...dev, GEMINI_API_KEY: 'k', GEMINI_FOOD_MODEL: 'gemini-9-ultra', GEMINI_FOOD_INPUT_USD_PER_M: '1', GEMINI_FOOD_OUTPUT_USD_PER_M: '2' }).GEMINI_FOOD_MODEL).toBe('gemini-9-ultra');
    });
  });
});
