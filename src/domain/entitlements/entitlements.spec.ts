import {
  canStartScan,
  entitlementView,
  freeScansRemaining,
  hmacEmail,
  isPlusActive,
  isVerifiedAccount,
  shouldChargeFreeScan,
} from './index';

const now = new Date('2026-11-02T12:00:00Z');
const future = new Date('2026-12-02T12:00:00Z');
const past = new Date('2026-11-01T12:00:00Z');

describe('entitlements', () => {
  describe('isPlusActive (BR-03)', () => {
    it('is active while activeUntil is in the future', () => {
      expect(isPlusActive({ plan: 'plus', activeUntil: future }, now)).toBe(true);
    });
    it('is inactive after expiry or refund, without a date, or on free', () => {
      expect(isPlusActive({ plan: 'plus', activeUntil: past }, now)).toBe(false);
      expect(isPlusActive({ plan: 'plus', activeUntil: now }, now)).toBe(false);
      expect(isPlusActive({ plan: 'plus', activeUntil: null }, now)).toBe(false);
      expect(isPlusActive({ plan: 'free', activeUntil: future }, now)).toBe(false);
    });
  });

  it('builds the entitlement view', () => {
    expect(entitlementView({ plan: 'free' }, now)).toEqual({
      plan: 'free',
      isPlus: false,
      period: null,
      activeUntil: null,
      source: null,
    });
    expect(
      entitlementView({ plan: 'plus', period: 'yearly', activeUntil: future, source: 'app_store' }, now),
    ).toEqual({
      plan: 'plus',
      isPlus: true,
      period: 'yearly',
      activeUntil: future.toISOString(),
      source: 'app_store',
    });
  });

  describe('freeScansRemaining (BR-01)', () => {
    it('uses the larger of account and ledger usage', () => {
      expect(freeScansRemaining({ allowance: 1, used: 0 })).toBe(1);
      expect(freeScansRemaining({ allowance: 1, used: 0, ledgerUsed: 1 })).toBe(0);
      expect(freeScansRemaining({ allowance: 3, used: 1, ledgerUsed: 0 })).toBe(2);
      expect(freeScansRemaining({ allowance: 1, used: 5 })).toBe(0);
    });
  });

  it('detects verified accounts (BR-16)', () => {
    expect(isVerifiedAccount({ emailVerifiedAt: now, authProviders: [] })).toBe(true);
    expect(isVerifiedAccount({ authProviders: [{ provider: 'google', emailVerified: true }] })).toBe(true);
    expect(isVerifiedAccount({ emailVerifiedAt: null, authProviders: [{ provider: 'apple', emailVerified: false }] })).toBe(
      false,
    );
  });

  describe('canStartScan', () => {
    const base = {
      verified: true,
      integrityOk: true,
      isPlus: false,
      freeRemaining: 1,
      plusScansToday: 0,
      plusDailyLimit: 30,
    };
    it('requires a verified account first', () => {
      expect(canStartScan({ ...base, verified: false, integrityOk: false })).toMatchObject({
        allowed: false,
        code: 'EMAIL_NOT_VERIFIED',
      });
    });
    it('requires integrity', () => {
      expect(canStartScan({ ...base, integrityOk: false })).toMatchObject({ allowed: false, code: 'INTEGRITY_REQUIRED' });
    });
    it('allows a free scan and marks it as consuming the allowance', () => {
      expect(canStartScan(base)).toEqual({ allowed: true, consumesFreeScan: true });
    });
    it('blocks free users without scans left', () => {
      expect(canStartScan({ ...base, freeRemaining: 0 })).toMatchObject({
        allowed: false,
        code: 'SCAN_LIMIT_REACHED',
        details: { plan: 'free' },
      });
    });
    it('lets Plus scan without consuming free scans, up to the daily limit', () => {
      expect(canStartScan({ ...base, isPlus: true, freeRemaining: 0 })).toEqual({ allowed: true, consumesFreeScan: false });
      expect(canStartScan({ ...base, isPlus: true, plusScansToday: 30 })).toMatchObject({
        allowed: false,
        code: 'SCAN_LIMIT_REACHED',
        details: { plan: 'plus', limit: 30 },
      });
    });
  });

  describe('shouldChargeFreeScan (BR-02)', () => {
    const base = { status: 'succeeded' as const, alreadyCharged: false, deduped: false, isPlus: false };
    it('charges only a first successful, non-deduped free scan', () => {
      expect(shouldChargeFreeScan(base)).toBe(true);
      expect(shouldChargeFreeScan({ ...base, alreadyCharged: true })).toBe(false);
      expect(shouldChargeFreeScan({ ...base, deduped: true })).toBe(false);
      expect(shouldChargeFreeScan({ ...base, isPlus: true })).toBe(false);
      for (const status of ['queued', 'processing', 'failed', 'rejected'] as const) {
        expect(shouldChargeFreeScan({ ...base, status })).toBe(false);
      }
    });
  });

  it('hashes emails with a pepper, normalising case and spaces (S-14)', () => {
    const a = hmacEmail(' Alex@Example.com ', 'pepper');
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(hmacEmail('alex@example.com', 'pepper')).toBe(a);
    expect(hmacEmail('alex@example.com', 'other')).not.toBe(a);
  });
});
