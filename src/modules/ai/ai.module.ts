import { Global, Logger, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { AiJobs } from './ai-jobs';
import { AiProvider, FakeAiProvider } from './ai.provider';
import { AiService } from './ai.service';
import { FoodScanBudget } from './food-scan-budget.service';
import { FoodScanService } from './food-scan.service';
import { FakeFoodVisionProvider, FoodVisionProvider, UnconfiguredFoodVisionProvider } from './providers/food-vision.provider';
import { GeminiFoodProvider } from './providers/gemini-food.provider';
import { GeminiProvider } from './providers/gemini.provider';

/**
 * modules/ai (M4-T2). Gemini whenever GEMINI_API_KEY is set. Without a key (development only: production
 * refuses to boot) the features that check `configured` say AI is not switched on and photo scans answer
 * AI_UNAVAILABLE (not_configured). Canned scan results only in tests and `pnpm start:local` (config.fakeAi).
 */
@Global()
@Module({
  providers: [
    AiService,
    AiJobs,
    FoodScanBudget,
    FoodScanService,
    {
      provide: AiProvider,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): AiProvider => {
        if (!c.fakeAi && c.GEMINI_API_KEY) return new GeminiProvider(c.GEMINI_API_KEY);
        if (!c.fakeAi) new Logger('AiModule').warn('GEMINI_API_KEY is empty: plan tips, recaps, live voice and photo scans say AI is not switched on; parse and coach give placeholder replies');
        return new FakeAiProvider();
      },
    },
    {
      provide: FoodVisionProvider,
      inject: [APP_CONFIG, AiProvider],
      useFactory: (c: AppConfig, ai: AiProvider): FoodVisionProvider => {
        // A test run never reaches Google, even with a key in .env.
        if (c.fakeAi) return new FakeFoodVisionProvider(ai instanceof FakeAiProvider ? ai : new FakeAiProvider());
        if (c.GEMINI_API_KEY) return new GeminiFoodProvider(c.GEMINI_API_KEY);
        return new UnconfiguredFoodVisionProvider();
      },
    },
  ],
  exports: [AiService, AiProvider, AiJobs, FoodScanBudget, FoodScanService, FoodVisionProvider],
})
export class AiModule {}
