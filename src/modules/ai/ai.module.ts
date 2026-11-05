import { Global, Logger, Module } from '@nestjs/common';
import type Redis from 'ioredis';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { REDIS_CONNECTION } from '../../infra/kv/kv.module';
import { AiJobHandlers, AiJobRunner, BullAiJobRunner, InlineAiJobRunner } from './ai-jobs';
import { AiProvider, FakeAiProvider } from './ai.provider';
import { AiService } from './ai.service';
import { FoodScanBudget } from './food-scan-budget.service';
import { FoodScanService } from './food-scan.service';
import { FakeFoodVisionProvider, FoodVisionProvider, UnconfiguredFoodVisionProvider } from './providers/food-vision.provider';
import { GeminiFoodProvider } from './providers/gemini-food.provider';
import { GeminiProvider } from './providers/gemini.provider';

/** modules/ai (M4-T2). The provider is chosen by AI_PROVIDER; production refuses `fake`. */
@Global()
@Module({
  providers: [
    AiService,
    AiJobHandlers,
    FoodScanBudget,
    FoodScanService,
    {
      provide: FoodVisionProvider,
      inject: [APP_CONFIG, AiProvider],
      useFactory: (c: AppConfig, ai: AiProvider): FoodVisionProvider => {
        // Tests and GEMINI_FOOD_MOCK get canned answers; a test run never reaches Google, even with a key in .env.
        if (c.GEMINI_FOOD_MOCK || c.NODE_ENV === 'test') return new FakeFoodVisionProvider(ai instanceof FakeAiProvider ? ai : new FakeAiProvider());
        if (c.GEMINI_API_KEY) return new GeminiFoodProvider(c.GEMINI_API_KEY);
        if (ai instanceof FakeAiProvider) return new FakeFoodVisionProvider(ai);
        new Logger('AiModule').warn('GEMINI_API_KEY is empty: food photo scans answer AI_UNAVAILABLE until it is set');
        return new UnconfiguredFoodVisionProvider();
      },
    },
    {
      provide: AiProvider,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): AiProvider => {
        if (c.AI_PROVIDER === 'gemini' && c.GEMINI_API_KEY) return new GeminiProvider(c.GEMINI_API_KEY);
        // Plan personalisation reports `not_configured` instead of showing made-up output (PLAN-GEN).
        new Logger('AiModule').warn(
          c.AI_PROVIDER === 'gemini'
            ? 'AI_PROVIDER=gemini but GEMINI_API_KEY is empty: AI features run on the fake provider and plan tips are switched off'
            : 'AI_PROVIDER=fake: AI features run on the fake provider and plan tips are switched off (set AI_PROVIDER=gemini and GEMINI_API_KEY)',
        );
        return new FakeAiProvider();
      },
    },
    {
      provide: AiJobRunner,
      inject: [REDIS_CONNECTION, AiJobHandlers],
      useFactory: (redis: Redis | null, handlers: AiJobHandlers): AiJobRunner =>
        redis ? new BullAiJobRunner(redis) : new InlineAiJobRunner(handlers),
    },
  ],
  exports: [AiService, AiProvider, AiJobHandlers, AiJobRunner, FoodScanBudget, FoodScanService, FoodVisionProvider],
})
export class AiModule {}
