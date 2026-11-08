import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../shared';
import { dayKeyFor } from '../../domain/day-keys';
import { KvStore } from '../../infra/kv/kv-store';
import { clock } from '../clock';
import { ApiError } from '../errors/api-error';

export type QuotaFeature = 'describe' | 'coach' | 'tts' | 'plan' | 'plan_attempt' | 'realtime' | 'recap' | 'fridge';

/**
 * Daily AI quotas (plan 8.9, OQ-38): counted per user and the user's local day (BR-07 day key, so
 * they reset at local midnight), checked before the call and consumed only after a successful
 * answer. Failed or degraded calls never consume quota.
 */
@Injectable()
export class DailyQuota {
  constructor(private readonly kv: KvStore) {}

  private key(feature: QuotaFeature, userId: string, timezone: string): string {
    return `quota:${feature}:${userId}:${dayKeyFor(clock.now(), timezone)}`;
  }

  async used(feature: QuotaFeature, userId: string, timezone: string): Promise<number> {
    return Number((await this.kv.get(this.key(feature, userId, timezone))) ?? 0);
  }

  /** Throws AI_LIMIT_REACHED (402 free → paywall `limit` trigger, 429 Plus) when the day is used up. */
  async assertAvailable(feature: QuotaFeature, userId: string, timezone: string, limit: number, plus: boolean, message: string): Promise<void> {
    if ((await this.used(feature, userId, timezone)) >= limit) {
      throw new ApiError(ERROR_CODES.AI_LIMIT_REACHED, message, plus ? HttpStatus.TOO_MANY_REQUESTS : HttpStatus.PAYMENT_REQUIRED, { limit, plan: plus ? 'plus' : 'free' });
    }
  }

  async consume(feature: QuotaFeature, userId: string, timezone: string): Promise<void> {
    await this.kv.incr(this.key(feature, userId, timezone), 48 * 3600);
  }
}
