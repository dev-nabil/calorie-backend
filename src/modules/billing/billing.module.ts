import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { RevenueCatVerifier, StoreVerifier, StubStoreVerifier } from './providers/store-verifier';
import { BillingController } from './controllers/billing.controller';
import { BillingEventsService } from './services/billing-events.service';
import { BillingService } from './services/billing.service';
import { RevenueCatWebhookController } from './controllers/revenuecat-webhook.controller';

@Module({
  controllers: [BillingController, RevenueCatWebhookController],
  providers: [
    BillingService,
    BillingEventsService,
    {
      provide: StoreVerifier,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): StoreVerifier => (c.REVENUECAT_API_KEY ? new RevenueCatVerifier(c.REVENUECAT_API_KEY) : new StubStoreVerifier()),
    },
  ],
  exports: [BillingService, BillingEventsService],
})
export class BillingModule {}
