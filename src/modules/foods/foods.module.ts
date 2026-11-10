import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { TrackingModule } from '../tracking/tracking.module';
import { FoodsController } from './foods.controller';
import { FoodsService } from './foods.service';
import { DisabledProductDatabase, FakeProductDatabase, OpenFoodFactsDatabase, ProductDatabase } from './providers/product-database.provider';

/** Packaged foods by barcode. Tests get a fixed catalogue and never reach Open Food Facts. */
@Module({
  imports: [TrackingModule],
  controllers: [FoodsController],
  providers: [
    FoodsService,
    {
      provide: ProductDatabase,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): ProductDatabase => {
        if (c.NODE_ENV === 'test') return new FakeProductDatabase();
        if (!c.PRODUCT_DB_ENABLED) return new DisabledProductDatabase();
        return new OpenFoodFactsDatabase(c.PRODUCT_DB_URL, c.PRODUCT_DB_USER_AGENT, c.PRODUCT_DB_TIMEOUT_MS);
      },
    },
  ],
  exports: [FoodsService, ProductDatabase],
})
export class FoodsModule {}
