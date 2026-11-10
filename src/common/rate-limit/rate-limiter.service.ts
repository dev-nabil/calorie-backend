import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { KvStore } from '../../infra/kv/kv-store';
import { ApiError } from '../errors/api-error';

export interface RateRule {
  /** Bucket name and subject, e.g. `otp:email:a@b.c`. */
  key: string;
  limit: number;
  windowSec: number;
}

/** Fixed-window counters in the key-value store (plan section 7, rate limits). Throws 429 with Retry-After. */
@Injectable()
export class RateLimiter {
  constructor(
    private readonly kv: KvStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** RATE_LIMIT_MULTIPLIER (tests only; 1 in production). */
  get multiplier(): number {
    return this.config.RATE_LIMIT_MULTIPLIER;
  }

  async consume(...rules: RateRule[]): Promise<void> {
    for (const rule of rules) {
      const { count, ttlSec } = await this.kv.incr(`rl:${rule.key}`, rule.windowSec);
      if (count > Math.ceil(rule.limit * this.multiplier)) throw ApiError.rateLimited(ttlSec);
    }
  }

  /** Counts without throwing; for daily usage limits checked elsewhere. */
  async peek(key: string): Promise<number> {
    return Number((await this.kv.get(`rl:${key}`)) ?? 0);
  }
}
