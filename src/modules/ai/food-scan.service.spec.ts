import sharp from 'sharp';
import type { SettingsService } from '../settings/settings.service';
import { AiService, AiUnavailableError } from './ai.service';
import type { FoodScanBudget, FoodScanHold } from './food-scan-budget.service';
import { FoodScanService } from './food-scan.service';
import { geminiCostUsd, knownGeminiPrice } from './gemini-pricing';
import { FoodVisionError, FoodVisionProvider, type FoodVisionResult } from './providers/food-vision.provider';

const values: Record<string, unknown> = {
  'scan.model': 'gemini-3.5-flash-lite',
  'scan.thinkingLevel': 'minimal',
  'scan.imageResolution': 'high',
  'scan.imageMaxEdgePx': 1024,
  'scan.maxOutputTokens': 2560,
  'scan.timeoutMs': 20_000,
  'scan.maxAttempts': 3,
};
const settings = {
  get: async (k: string) => values[k],
  many: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, values[k]])),
} as unknown as SettingsService;

const ok: FoodVisionResult = { output: {}, truncated: false, usage: { inputTokens: 1800, cachedTokens: 0, outputTokens: 400, thoughtTokens: 30 }, model: 'gemini-3.5-flash-lite' };

function harness(script: Array<FoodVisionResult | Error>) {
  const budget = {
    reserve: jest.fn(async (): Promise<FoodScanHold> => ({ date: '2026-11-04', microUsd: 7000 })),
    settle: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    price: async () => knownGeminiPrice('gemini-3.5-flash-lite')!,
  };
  const provider = {
    configured: true,
    analyse: jest.fn(async () => {
      const next = script.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  const ai = { runExternal: (_f: string, call: () => Promise<unknown>) => call() };
  const service = new FoodScanService(settings, ai as unknown as AiService, budget as unknown as FoodScanBudget, provider as unknown as FoodVisionProvider);
  return { service, budget, provider };
}

const photo = () => sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#a63' } }).jpeg().toBuffer();
const input = async () => ({ scanId: 's', instructions: 'i', context: 'c', image: await photo() });
const busy = () => new FoodVisionError('Gemini HTTP 503', 'transient', 503, 1);

describe('FoodScanService', () => {
  it('makes one call in the normal case and records the true cost, thinking included', async () => {
    const { service, budget, provider } = harness([ok]);
    const res = await service.analyse(await input());
    expect(provider.analyse).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ attempts: 1, usage: { outputTokens: 430 } });
    expect(res.costUsd).toBeCloseTo((1800 * 0.3 + 430 * 2.5) / 1e6, 8);
    expect(budget.settle).toHaveBeenCalledTimes(1);
    expect(budget.release).not.toHaveBeenCalled();
  });

  it('sends a resized JPEG without metadata', async () => {
    const { service, provider } = harness([ok]);
    await service.analyse(await input());
    const sent = (provider.analyse.mock.calls as unknown as [{ image: { bytes: Buffer } }][])[0]![0].image.bytes;
    const meta = await sharp(sent).metadata();
    expect([meta.width, meta.height, meta.format, meta.exif]).toEqual([1024, 768, 'jpeg', undefined]);
  });

  it('retries transient errors with a reservation for each try, then succeeds', async () => {
    const { service, budget, provider } = harness([busy(), busy(), ok]);
    expect((await service.analyse(await input())).attempts).toBe(3);
    expect(provider.analyse).toHaveBeenCalledTimes(3);
    expect(budget.reserve).toHaveBeenCalledTimes(3);
    expect(budget.release).toHaveBeenCalledTimes(2);
    expect(budget.settle).toHaveBeenCalledTimes(1);
  });

  it('stops at the attempt limit', async () => {
    const { service, provider } = harness([busy(), busy(), busy(), ok]);
    await expect(service.analyse(await input())).rejects.toBeInstanceOf(FoodVisionError);
    expect(provider.analyse).toHaveBeenCalledTimes(3);
  });

  it('does not retry a permanent error', async () => {
    const { service, provider } = harness([new FoodVisionError('Gemini HTTP 400', 'permanent', 400), ok]);
    await expect(service.analyse(await input())).rejects.toMatchObject({ kind: 'permanent' });
    expect(provider.analyse).toHaveBeenCalledTimes(1);
  });

  it('counts a timed-out call as spent, since Google may bill it', async () => {
    const { service, budget } = harness([new FoodVisionError('Gemini timed out', 'timeout', undefined, 1), ok]);
    await service.analyse(await input());
    expect(budget.release).toHaveBeenCalledWith(expect.anything(), { maybeBilled: true });
  });

  it('does not retry past a closed cap', async () => {
    const { service, budget, provider } = harness([busy(), ok]);
    budget.reserve.mockResolvedValueOnce({ date: 'd', microUsd: 1 }).mockRejectedValueOnce(new AiUnavailableError('daily_cap', 60));
    await expect(service.analyse(await input())).rejects.toMatchObject({ reason: 'daily_cap' });
    expect(provider.analyse).toHaveBeenCalledTimes(1);
  });

  it('says so when no key is configured, instead of inventing a result', async () => {
    const { service, provider } = harness([ok]);
    provider.configured = false;
    await expect(service.assertAvailable()).rejects.toMatchObject({ reason: 'not_configured' });
  });

  it('builds a cache key from everything that shapes the reply', async () => {
    const { service } = harness([]);
    const base = { imageHash: 'a'.repeat(64), locale: 'en', dietPattern: '', promptKey: 'meal-scan', promptVersion: 2 };
    expect(await service.cacheKey(base)).toBe(await service.cacheKey({ ...base }));
    for (const change of [{ imageHash: 'b'.repeat(64) }, { locale: 'bn' }, { dietPattern: 'vegetarian' }, { promptVersion: 3 }]) {
      expect(await service.cacheKey({ ...base, ...change })).not.toBe(await service.cacheKey(base));
    }
  });
});

describe('Gemini cost', () => {
  it('bills thinking at the output rate and cached input at the cached rate', () => {
    const price = knownGeminiPrice('gemini-3.5-flash-lite')!;
    expect(geminiCostUsd({ inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0, thoughtTokens: 0 }, price)).toBeCloseTo(0.3);
    expect(geminiCostUsd({ inputTokens: 0, cachedTokens: 0, outputTokens: 500_000, thoughtTokens: 500_000 }, price)).toBeCloseTo(2.5);
    expect(geminiCostUsd({ inputTokens: 1_000_000, cachedTokens: 1_000_000, outputTokens: 0, thoughtTokens: 0 }, price)).toBeCloseTo(0.03);
  });
});
