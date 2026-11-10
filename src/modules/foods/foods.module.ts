import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { SettingsService } from '../settings/settings.service';
import { TrackingModule } from '../tracking/tracking.module';
import { FoodsController } from './foods.controller';
import { FoodsService } from './foods.service';
import { FakeProductDatabase, OpenFoodFactsDatabase, ProductDatabase } from './providers/product-database.provider';

/** Packaged foods by barcode. Tests get a fixed catalogue and never reach Open Food Facts. */
@Module({
  imports: [TrackingModule],
  controllers: [FoodsController],
  providers: [
    FoodsService,
    {
      provide: ProductDatabase,
      inject: [APP_CONFIG, SettingsService],
      useFactory: (c: AppConfig, settings: SettingsService): ProductDatabase => {
        if (c.NODE_ENV === 'test') return new FakeProductDatabase();
        return new OpenFoodFactsDatabase(async () => {
          const s = await settings.many(['foods.barcode.enabled', 'foods.barcode.baseUrl', 'foods.barcode.userAgent', 'foods.barcode.timeoutMs']);
          return { enabled: s['foods.barcode.enabled'], baseUrl: s['foods.barcode.baseUrl'], userAgent: s['foods.barcode.userAgent'], timeoutMs: s['foods.barcode.timeoutMs'] };
        });
      },
    },
  ],
  exports: [FoodsService, ProductDatabase],
})
export class FoodsModule {}
