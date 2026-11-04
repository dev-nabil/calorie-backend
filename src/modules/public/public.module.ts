import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';
import { AllowTurnstileVerifier, CloudflareTurnstileVerifier, TurnstileVerifier } from './turnstile.verifier';

@Module({
  controllers: [PublicController],
  providers: [
    PublicService,
    {
      provide: TurnstileVerifier,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => (c.TURNSTILE_SECRET ? new CloudflareTurnstileVerifier(c.TURNSTILE_SECRET) : new AllowTurnstileVerifier()),
    },
  ],
})
export class PublicModule {}
