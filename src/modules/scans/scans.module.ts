import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module';
import { TrackingModule } from '../tracking/tracking.module';
import { ScanQueue } from './scan-queue';
import { ScanProcessor } from './services/scan.processor';
import { ScansController } from './scans.controller';
import { ScansService } from './services/scans.service';
import { ScanSweep } from './services/scan-sweep.service';

/** Photo scans: endpoints, the in-process processor and the stuck-scan sweep. */
@Module({
  imports: [PlansModule, TrackingModule],
  controllers: [ScansController],
  providers: [
    ScanProcessor,
    { provide: ScanQueue, inject: [ScanProcessor], useFactory: (processor: ScanProcessor) => new ScanQueue((id) => processor.process(id)) },
    ScansService,
    ScanSweep,
  ],
  exports: [ScanQueue, ScanProcessor],
})
export class ScansModule {}
