import type { FakeAiProvider } from '../ai.provider';
import type { GeminiTokens } from '../gemini-pricing';

export interface FoodVisionRequest {
  model: string;
  instructions: string;
  context: string;
  image: { bytes: Buffer; mimeType: 'image/jpeg' };
  resolution: 'low' | 'medium' | 'high';
  thinkingLevel: 'minimal' | 'low' | 'medium' | 'high';
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface FoodVisionResult {
  /** Parsed JSON, or the raw text when it does not parse; the caller validates either. */
  output: unknown;
  /** The output limit cut the reply short. */
  truncated: boolean;
  usage: GeminiTokens;
  model: string;
}

/** `timeout`: the request may have reached the model, so it may be billed. */
export type FoodVisionFailure = 'transient' | 'timeout' | 'permanent';

/** Carries a status and kind only: never a request body or a header. */
export class FoodVisionError extends Error {
  constructor(
    message: string,
    readonly kind: FoodVisionFailure,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** One model call for one photo, no retries. Implemented by Gemini and, in dev and tests, by a fake. */
export abstract class FoodVisionProvider {
  abstract readonly name: string;
  abstract readonly configured: boolean;
  abstract analyse(req: FoodVisionRequest): Promise<FoodVisionResult>;
}

/** No key yet: scans say so instead of showing made-up nutrition. */
export class UnconfiguredFoodVisionProvider extends FoodVisionProvider {
  readonly name = 'none';
  readonly configured = false;
  analyse(): Promise<FoodVisionResult> {
    return Promise.reject(new FoodVisionError('GEMINI_API_KEY is not set', 'permanent'));
  }
}

/** Dev and tests: answers come from the fake AI provider, so `enqueue` and `mode` drive scans too. */
export class FakeFoodVisionProvider extends FoodVisionProvider {
  readonly name = 'fake';
  readonly configured = true;
  readonly calls: FoodVisionRequest[] = [];
  /** Next results as the provider would return them, for truncated output and token counts. */
  private readonly scripted: Array<Partial<FoodVisionResult>> = [];

  constructor(private readonly fake: FakeAiProvider) {
    super();
  }

  script(...results: Array<Partial<FoodVisionResult>>): void {
    this.scripted.push(...results);
  }

  reset(): void {
    this.calls.length = 0;
    this.scripted.length = 0;
  }

  async analyse(req: FoodVisionRequest): Promise<FoodVisionResult> {
    this.calls.push(req);
    const next = this.scripted.shift();
    const usage = { inputTokens: 1600, cachedTokens: 0, outputTokens: 420, thoughtTokens: 0 };
    if (next) return { output: null, truncated: false, usage, model: req.model, ...next };
    try {
      const res = await this.fake.structured({ task: 'meal_scan', model: req.model, instructions: req.instructions, context: req.context, timeoutMs: req.timeoutMs, maxOutputTokens: req.maxOutputTokens });
      return { output: res.output, truncated: false, usage, model: req.model };
    } catch (e) {
      const status = (e as { status?: number }).status;
      const transient = status === undefined || status >= 500 || status === 429;
      throw new FoodVisionError((e as Error).message, transient ? 'transient' : 'permanent', status, 1);
    }
  }
}
