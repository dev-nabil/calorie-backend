import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { ERROR_CODES, type AiFeature } from '../../shared';

/**
 * Features that go through the AI service. `plan` (plan narrative) and `realtime` (voice conversation) are
 * internal: each has its own kill switch (`ai.kill.plan`, `ai.kill.realtime`), circuit breaker, model
 * (`ai.model.<feature>`) and usage row, but is not part of the public config contract or the admin AI
 * settings form (the `voice.realtime` flag is the admin's switch for the realtime voice).
 */
export type AiRunFeature = AiFeature | 'plan' | 'realtime';
import { ApiError } from '../../common/errors/api-error';
import { AppConfigService } from '../content/app-config.service';
import { AiProvider, FakeAiProvider, type AiResult, type AiUsage } from './ai.provider';
import { knownGeminiPrice } from './gemini-pricing';
import type { AiUsageDailyDoc } from './schemas/ai.schema';
import { CircuitBreaker } from './circuit-breaker';

/** Thrown when a kill switch, open breaker or the budget guard stops a call (plan 8.10). */
export class AiUnavailableError extends ApiError {
  constructor(
    public readonly reason: 'kill_switch' | 'circuit_open' | 'budget' | 'provider_error' | 'daily_cap' | 'not_configured',
    retryAfterSec: number,
  ) {
    super(ERROR_CODES.AI_UNAVAILABLE, 'Milo is resting. Try again soon.', HttpStatus.SERVICE_UNAVAILABLE, { reason, retryAfterSec }, {
      'Retry-After': String(retryAfterSec),
    });
  }
}

interface Price {
  inputPerM: number;
  cachedPerM: number;
  outputPerM: number;
}

const BUDGET_STOP_SHARE = 0.95; // plan 8.9: downgrade at 95% of the monthly limit
const isRetryable = (e: unknown): boolean => {
  const status = (e as { status?: number }).status;
  return status === undefined || status >= 500 || status === 429;
};

/**
 * The only path to a model (plan 8.1): kill switches from app_config (`ai.kill.<feature>`),
 * a circuit breaker per feature, the monthly budget guard, one retry with backoff on network/5xx,
 * and usage plus cost logging (cached tokens included) into ai_usage_daily.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger('AiService');
  private readonly breakers = new Map<AiRunFeature, CircuitBreaker>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectModel('AiUsageDaily') private readonly usage: Model<AiUsageDailyDoc>,
    private readonly appConfig: AppConfigService,
    private readonly provider: AiProvider,
  ) {}

  breaker(feature: AiRunFeature): CircuitBreaker {
    let b = this.breakers.get(feature);
    if (!b) this.breakers.set(feature, (b = new CircuitBreaker()));
    return b;
  }

  /**
   * Throws AiUnavailableError when the feature may not call the model now. `monthlyBudget: false` is for
   * food photo scans, which have their own daily caps: the monthly budget below covers every other feature.
   */
  async assertAvailable(feature: AiRunFeature, opts: { monthlyBudget?: boolean } = {}): Promise<void> {
    if (this.provider instanceof FakeAiProvider && this.provider.mode === 'unavailable') throw new AiUnavailableError('kill_switch', 60);
    if (await this.appConfig.get<boolean>(`ai.kill.${feature}`, false)) throw new AiUnavailableError('kill_switch', 120);
    const b = this.breaker(feature);
    if (b.state() === 'open') throw new AiUnavailableError('circuit_open', b.retryAfterSec() || 30);
    if (opts.monthlyBudget === false) return;
    // Admin AI settings (ai.budget) win over AI_MONTHLY_BUDGET_USD; downgrade at downgradePct (plan 8.9).
    const cfg = await this.appConfig.get<{ monthlyLimitUsd?: number; downgradePct?: number } | null>('ai.budget', null);
    const budget = cfg?.monthlyLimitUsd || this.config.AI_MONTHLY_BUDGET_USD;
    const share = cfg?.downgradePct ? cfg.downgradePct / 100 : BUDGET_STOP_SHARE;
    if (budget && (await this.monthSpend()) >= budget * share) throw new AiUnavailableError('budget', 3600);
  }

  async run(feature: AiRunFeature, call: () => Promise<AiResult>, opts: { retry?: boolean } = {}): Promise<AiResult & { costUsd: number }> {
    await this.assertAvailable(feature);
    const b = this.breaker(feature);
    if (!b.allow()) throw new AiUnavailableError('circuit_open', b.retryAfterSec() || 30);
    let result: AiResult;
    try {
      result = await call().catch(async (e: unknown) => {
        if (opts.retry === false || !isRetryable(e)) throw e;
        await new Promise((r) => setTimeout(r, 500));
        return call();
      });
    } catch (e) {
      b.record(false);
      await this.log(feature, 'unknown', null);
      throw e;
    }
    b.record(true);
    const costUsd = await this.cost(result.model, result.usage);
    await this.log(feature, result.model, result.usage, costUsd);
    return { ...result, costUsd };
  }

  /**
   * For calls outside the monthly budget: same kill switch, breaker and usage row as `run`, but the
   * caller owns retries and cost. Refusals by the caller's own caps say nothing about provider health.
   */
  async runExternal<T extends AiResult & { costUsd: number }>(feature: AiRunFeature, call: () => Promise<T>): Promise<T> {
    await this.assertAvailable(feature, { monthlyBudget: false });
    const b = this.breaker(feature);
    if (!b.allow()) throw new AiUnavailableError('circuit_open', b.retryAfterSec() || 30);
    let result: T;
    try {
      result = await call();
    } catch (e) {
      b.record(e instanceof AiUnavailableError);
      await this.log(feature, 'unknown', null);
      throw e;
    }
    b.record(true);
    await this.log(feature, result.model, result.usage, result.costUsd);
    return result;
  }

  /**
   * For request-path features (parse, extraction, coach, speech): a provider failure after the
   * retry is reported as AI_UNAVAILABLE (503 + retryAfterSec) so the app degrades, never as a 500
   * (QA B14). Scans keep `run`, where the processor decides between failed and queued.
   */
  async runOrUnavailable(feature: AiRunFeature, call: () => Promise<AiResult>): Promise<AiResult & { costUsd: number }> {
    try {
      return await this.run(feature, call);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new AiUnavailableError('provider_error', 30);
    }
  }

  async modelFor(feature: AiRunFeature | 'moderation', fallback: string): Promise<string> {
    return this.appConfig.get<string>(`ai.model.${feature}`, fallback);
  }

  private async cost(model: string, u: AiUsage): Promise<number> {
    // An admin price (`ai.price.<model>`) wins; otherwise the built-in Gemini table, so the budget guard never sees a zero.
    const p = (await this.appConfig.get<Price | null>(`ai.price.${model}`, null)) ?? knownGeminiPrice(model);
    if (!p) return 0;
    const fresh = Math.max(0, u.inputTokens - u.cachedTokens);
    return (fresh * p.inputPerM + u.cachedTokens * p.cachedPerM + u.outputTokens * p.outputPerM) / 1_000_000;
  }

  /** Usage that did not pass through `run` (the Live voice call goes from the app to Google; the app reports the tokens). */
  async recordUsage(feature: AiRunFeature, model: string, u: AiUsage, costUsd: number): Promise<void> {
    await this.log(feature, model, u, costUsd);
  }

  private async log(feature: AiRunFeature, model: string, u: AiUsage | null, costUsd = 0): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    await this.usage.updateOne(
      { date, feature, model },
      {
        $inc: {
          requests: 1,
          failures: u ? 0 : 1,
          inputTokens: u?.inputTokens ?? 0,
          cachedTokens: u?.cachedTokens ?? 0,
          outputTokens: u?.outputTokens ?? 0,
          costUsd,
        },
      },
      { upsert: true },
    );
  }

  /** AI spend this month, every feature except food photo scans (`vision`), which have their own daily caps. */
  async monthSpend(now = new Date()): Promise<number> {
    const prefix = now.toISOString().slice(0, 7);
    const [agg] = await this.usage.aggregate<{ total: number }>([
      { $match: { date: { $gte: `${prefix}-01`, $lte: `${prefix}-31` }, feature: { $ne: 'vision' } } },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]);
    return agg?.total ?? 0;
  }
}
