import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { clock } from '../../common/clock';
import { AppConfigService } from '../content/app-config.service';
import { SettingsService } from '../settings/settings.service';
import { AiUnavailableError } from './ai.service';
import { geminiCostUsd, knownGeminiPrice, type GeminiPrice, type GeminiTokens } from './gemini-pricing';
import type { FoodScanUsageDailyDoc } from './schemas/ai.schema';

/** Prompt, schema and a high-resolution image come to about 2,000 tokens; this leaves a margin. */
const RESERVED_INPUT_TOKENS = 3000;
const MICRO = 1_000_000;

export interface FoodScanLimits {
  dailyRequests: number;
  dailySpendUsd: number;
}

/** A call's place under the caps until its real cost is known. */
export interface FoodScanHold {
  date: string;
  microUsd: number;
}

const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

function secondsToUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Daily request and spending caps for Gemini scans (admin settings scan.dailyRequestCap and
 * scan.dailySpendUsd). Each call reserves its worst case with one atomic update before it starts, so
 * any number of processes cannot pass a cap together.
 * A crash between reserve and settle leaves the hold in place until the day ends: the cap errs low.
 */
@Injectable()
export class FoodScanBudget {
  constructor(
    @InjectModel('FoodScanUsageDaily') private readonly usage: Model<FoodScanUsageDailyDoc>,
    private readonly settings: SettingsService,
    private readonly appConfig: AppConfigService,
  ) {}

  /**
   * An admin price (app_config `ai.price.<model>`) wins over the built-in table. Setting scan.model refuses
   * a model without either, so a real scan is never priced at zero; zero only serves the fake provider.
   */
  async price(model: string): Promise<GeminiPrice> {
    const custom = await this.appConfig.get<Partial<GeminiPrice> | null>(`ai.price.${model}`, null);
    const known = knownGeminiPrice(model);
    const inputPerM = custom?.inputPerM ?? known?.inputPerM ?? 0;
    return { inputPerM, cachedPerM: custom?.cachedPerM ?? known?.cachedPerM ?? inputPerM, outputPerM: custom?.outputPerM ?? known?.outputPerM ?? 0 };
  }

  async limits(): Promise<FoodScanLimits> {
    const s = await this.settings.many(['scan.dailyRequestCap', 'scan.dailySpendUsd']);
    return { dailyRequests: s['scan.dailyRequestCap'], dailySpendUsd: s['scan.dailySpendUsd'] };
  }

  private async reserveMicroUsd(model: string, maxOutputTokens?: number): Promise<number> {
    const outputTokens = maxOutputTokens ?? (await this.settings.get('scan.maxOutputTokens'));
    const worst = { inputTokens: RESERVED_INPUT_TOKENS, cachedTokens: 0, outputTokens, thoughtTokens: 0 };
    return Math.ceil(geminiCostUsd(worst, await this.price(model)) * MICRO);
  }

  private closed(now: Date): AiUnavailableError {
    return new AiUnavailableError('daily_cap', secondsToUtcMidnight(now));
  }

  /** Early, non-binding check for POST /scans. `reserve` is the check that counts. */
  async assertOpen(model: string, now = clock.now()): Promise<void> {
    const limits = await this.limits();
    const day = await this.usage.findById(dayOf(now)).lean<FoodScanUsageDailyDoc>();
    const requests = (day?.requests ?? 0) + (day?.reservedRequests ?? 0);
    const micro = (day?.spendMicroUsd ?? 0) + (day?.reservedMicroUsd ?? 0) + (await this.reserveMicroUsd(model));
    if (requests >= limits.dailyRequests || micro > limits.dailySpendUsd * MICRO) throw this.closed(now);
  }

  async reserve(model: string, maxOutputTokens?: number, now = clock.now()): Promise<FoodScanHold> {
    const limits = await this.limits();
    const date = dayOf(now);
    const microUsd = await this.reserveMicroUsd(model, maxOutputTokens);
    await this.usage.updateOne({ _id: date }, { $setOnInsert: { requests: 0 } }, { upsert: true }).catch((e: { code?: number }) => {
      if (e.code !== 11000) throw e; // two first calls of the day: the other one created it
    });
    const taken = await this.usage.updateOne(
      {
        _id: date,
        $expr: {
          $and: [
            { $lt: [{ $add: ['$requests', '$reservedRequests'] }, limits.dailyRequests] },
            { $lte: [{ $add: ['$spendMicroUsd', '$reservedMicroUsd', microUsd] }, limits.dailySpendUsd * MICRO] },
          ],
        },
      },
      { $inc: { reservedRequests: 1, reservedMicroUsd: microUsd } },
    );
    if (taken.modifiedCount !== 1) throw this.closed(now);
    return { date, microUsd };
  }

  /** The call finished: swap the reservation for what it really cost. */
  async settle(hold: FoodScanHold, tokens: GeminiTokens, costUsd: number): Promise<void> {
    await this.usage.updateOne(
      { _id: hold.date },
      {
        $inc: {
          reservedRequests: -1,
          reservedMicroUsd: -hold.microUsd,
          requests: 1,
          spendMicroUsd: Math.ceil(costUsd * MICRO),
          inputTokens: tokens.inputTokens,
          outputTokens: tokens.outputTokens,
          thoughtTokens: tokens.thoughtTokens,
        },
      },
    );
  }

  /** The call failed. After a timeout Google may still bill it, so the reservation stands as spend. */
  async release(hold: FoodScanHold, opts: { maybeBilled: boolean }): Promise<void> {
    await this.usage.updateOne(
      { _id: hold.date },
      {
        $inc: {
          reservedRequests: -1,
          reservedMicroUsd: -hold.microUsd,
          requests: 1,
          failures: 1,
          spendMicroUsd: opts.maybeBilled ? hold.microUsd : 0,
        },
      },
    );
  }
}
