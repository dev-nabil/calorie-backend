import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { prepareScanImage } from '../../infra/media/scan-image';
import type { ScanMode } from '../../shared';
import { AiService, AiUnavailableError } from './ai.service';
import { FoodScanBudget } from './food-scan-budget.service';
import { geminiCostUsd, type GeminiTokens } from './gemini-pricing';
import { FoodVisionError, FoodVisionProvider, type FoodVisionResult } from './providers/food-vision.provider';

/** The app stops polling at 40 s; every attempt has to finish before that. */
const TOTAL_BUDGET_MS = 38_000;
const MIN_ATTEMPT_MS = 5_000;
const BACKOFF_MS = 800;
const MAX_WAIT_MS = 5_000;

export interface FoodScanInput {
  scanId: string;
  /** Default meal. */
  mode?: ScanMode;
  instructions: string;
  context: string;
  image: Buffer;
}

export interface FoodScanResult {
  output: unknown;
  truncated: boolean;
  model: string;
  usage: GeminiTokens;
  costUsd: number;
  attempts: number;
  modelLatencyMs: number;
}

export interface FoodScanCacheInput {
  imageHash: string;
  locale: string;
  dietPattern: string;
  promptKey: string;
  promptVersion: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One photo, one model call in the normal case. No fallback model: a failure stays a failure, never a dearer retry. */
@Injectable()
export class FoodScanService {
  private readonly logger = new Logger('FoodScan');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly ai: AiService,
    private readonly budget: FoodScanBudget,
    private readonly provider: FoodVisionProvider,
  ) {}

  get model(): string {
    return this.config.GEMINI_FOOD_MODEL;
  }

  /** Identical inputs give identical results, so everything that shapes the reply is in the key. */
  cacheKey(i: FoodScanCacheInput): string {
    const c = this.config;
    const parts = [i.imageHash, i.locale, i.dietPattern, this.model, i.promptKey, i.promptVersion, c.GEMINI_FOOD_THINKING_LEVEL, c.GEMINI_FOOD_IMAGE_RESOLUTION];
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }

  /** For POST /scans, before anything is queued. */
  async assertAvailable(): Promise<void> {
    if (!this.provider.configured) throw new AiUnavailableError('not_configured', 3600);
    await this.ai.assertAvailable('vision', { monthlyBudget: false });
    await this.budget.assertOpen(this.model);
  }

  async analyse(input: FoodScanInput): Promise<FoodScanResult> {
    const image = await prepareScanImage(input.image, this.config.GEMINI_FOOD_IMAGE_MAX_EDGE);
    const result = await this.ai.runExternal('vision', () => this.callWithRetries(input, image));
    this.logger.log(
      { scanId: input.scanId, model: result.model, attempts: result.attempts, latencyMs: result.modelLatencyMs, ...result.usage, costUsd: result.costUsd, truncated: result.truncated },
      'food scan',
    );
    return result;
  }

  private async callWithRetries(input: FoodScanInput, image: Buffer): Promise<FoodScanResult & { usage: GeminiTokens }> {
    const c = this.config;
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
      const hold = await this.budget.reserve(this.model);
      let res: FoodVisionResult;
      try {
        res = await this.provider.analyse({
          mode: input.mode ?? 'meal',
          model: this.model,
          instructions: input.instructions,
          context: input.context,
          image: { bytes: image, mimeType: 'image/jpeg' },
          resolution: c.GEMINI_FOOD_IMAGE_RESOLUTION,
          thinkingLevel: c.GEMINI_FOOD_THINKING_LEVEL,
          maxOutputTokens: c.GEMINI_FOOD_MAX_OUTPUT_TOKENS,
          timeoutMs: Math.min(c.GEMINI_FOOD_TIMEOUT_MS, remaining),
        });
      } catch (e) {
        const failure = e instanceof FoodVisionError ? e : new FoodVisionError('Provider call failed', 'permanent');
        await this.budget.release(hold, { maybeBilled: failure.kind === 'timeout' });
        const wait = Math.min(failure.retryAfterMs ?? BACKOFF_MS * 2 ** (attempt - 1), MAX_WAIT_MS) + Math.floor(Math.random() * 200);
        const timeLeft = TOTAL_BUDGET_MS - (Date.now() - started) - wait;
        if (failure.kind === 'permanent' || attempt >= c.GEMINI_FOOD_MAX_ATTEMPTS || timeLeft < MIN_ATTEMPT_MS) throw failure;
        this.logger.warn({ scanId: input.scanId, attempt, kind: failure.kind, status: failure.status }, 'food scan retry');
        await sleep(wait);
        continue;
      }
      const costUsd = geminiCostUsd(res.usage, this.budget.price(res.model));
      await this.budget.settle(hold, res.usage, costUsd);
      // Thinking bills as output, so the shared usage row counts both.
      const usage = { ...res.usage, outputTokens: res.usage.outputTokens + res.usage.thoughtTokens };
      return { output: res.output, truncated: res.truncated, model: res.model, usage, costUsd, attempts: attempt, modelLatencyMs: Date.now() - started };
    }
  }
}
