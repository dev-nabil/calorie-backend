/**
 * Entitlements and scan charging (BR-01, BR-02, BR-03, BR-16, S-14).
 */
import { createHmac } from 'node:crypto';
import type { Entitlement, EntitlementPeriod, EntitlementPlan, EntitlementSource, ScanStatus } from '../../shared';

export interface EntitlementState {
  plan: EntitlementPlan;
  period?: EntitlementPeriod | null;
  activeUntil?: Date | null;
  source?: EntitlementSource | null;
}

/**
 * BR-03: Plus is active while activeUntil is in the future (the webhook sets it to the end of
 * the grace period). Expiry and refunds return the user to Free immediately.
 */
export function isPlusActive(ent: Pick<EntitlementState, 'plan' | 'activeUntil'>, now: Date): boolean {
  return ent.plan === 'plus' && !!ent.activeUntil && ent.activeUntil.getTime() > now.getTime();
}

/** API view of an entitlement. */
export function entitlementView(ent: EntitlementState, now: Date): Entitlement {
  return {
    plan: ent.plan,
    isPlus: isPlusActive(ent, now),
    period: ent.period ?? null,
    activeUntil: ent.activeUntil ? ent.activeUntil.toISOString() : null,
    source: ent.source ?? null,
  };
}

/**
 * BR-01: free scans are counted per account and per email (scan_ledger survives deletion),
 * so the larger of the two counts applies.
 */
export function freeScansRemaining(i: { allowance: number; used: number; ledgerUsed?: number }): number {
  return Math.max(0, i.allowance - Math.max(i.used, i.ledgerUsed ?? 0));
}

export interface VerifiableAccount {
  emailVerifiedAt?: Date | null;
  authProviders: { provider: string; emailVerified: boolean }[];
}

/** BR-16: email code completed, or Google/Apple asserting a verified email. */
export function isVerifiedAccount(u: VerifiableAccount): boolean {
  return !!u.emailVerifiedAt || u.authProviders.some((p) => p.emailVerified);
}

export interface ScanCheckInput {
  verified: boolean;
  integrityOk: boolean;
  isPlus: boolean;
  freeRemaining: number;
  plusScansToday: number;
  plusDailyLimit: number;
}

export type ScanDecision =
  | { allowed: true; consumesFreeScan: boolean }
  | {
      allowed: false;
      code: 'EMAIL_NOT_VERIFIED' | 'INTEGRITY_REQUIRED' | 'SCAN_LIMIT_REACHED';
      details: Record<string, unknown>;
    };

/** Decide whether a scan may be queued. Order: verified (BR-16) → integrity (DEC-19) → limits. */
export function canStartScan(i: ScanCheckInput): ScanDecision {
  if (!i.verified) return { allowed: false, code: 'EMAIL_NOT_VERIFIED', details: {} };
  if (!i.integrityOk) return { allowed: false, code: 'INTEGRITY_REQUIRED', details: {} };
  if (i.isPlus) {
    if (i.plusScansToday >= i.plusDailyLimit) {
      return {
        allowed: false,
        code: 'SCAN_LIMIT_REACHED',
        details: { plan: 'plus', limit: i.plusDailyLimit, period: 'day' },
      };
    }
    return { allowed: true, consumesFreeScan: false };
  }
  if (i.freeRemaining <= 0) {
    return { allowed: false, code: 'SCAN_LIMIT_REACHED', details: { plan: 'free', remaining: 0 } };
  }
  return { allowed: true, consumesFreeScan: true };
}

/**
 * BR-02: a scan is charged only when it succeeds, only once per scanId, never when deduped,
 * rejected or failed. Plus scans never consume the free allowance.
 */
export function shouldChargeFreeScan(i: {
  status: ScanStatus;
  alreadyCharged: boolean;
  deduped: boolean;
  isPlus: boolean;
}): boolean {
  return i.status === 'succeeded' && !i.alreadyCharged && !i.deduped && !i.isPlus;
}

/** S-14: HMAC-SHA256 of the normalised email with a server-side pepper (scan_ledger key). */
export function hmacEmail(email: string, pepper: string): string {
  return createHmac('sha256', pepper).update(email.trim().toLowerCase()).digest('hex');
}
