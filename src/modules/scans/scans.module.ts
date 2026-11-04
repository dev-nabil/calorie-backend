import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module';
import { TrackingModule } from '../tracking/tracking.module';
import { ScanQueue } from './scan-queue';
import { ScanProcessor } from './services/scan.processor';
import { ScansController } from './scans.controller';
import { ScansService } from './services/scans.service';
import { InlineSweep } from './services/inline-sweep.service';
import { scanCoreProviders } from './scans.providers';

/** API role: endpoints. Without Redis the processor and the sweep run in-process (dev only). */
@Module({
  imports: [PlansModule, TrackingModule],
  controllers: [ScansController],
  providers: [...scanCoreProviders, ScansService, InlineSweep],
  exports: [ScanQueue, ScanProcessor],
})
export class ScansModule {}
