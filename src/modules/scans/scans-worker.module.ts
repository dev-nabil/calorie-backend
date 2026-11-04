import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module';
import { TrackingModule } from '../tracking/tracking.module';
import { ScanWorker } from './services/scan-worker.service';
import { scanCoreProviders } from './scans.providers';

/** Worker role: BullMQ processor for queue `scans` plus the stuck-job sweep. */
@Module({
  imports: [PlansModule, TrackingModule],
  providers: [...scanCoreProviders, ScanWorker],
})
export class ScansWorkerModule {}
