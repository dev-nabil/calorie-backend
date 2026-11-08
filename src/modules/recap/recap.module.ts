import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module';
import { TrackingModule } from '../tracking/tracking.module';
import { RecapController } from './recap.controller';
import { RecapService } from './recap.service';
import { WeeklyRecapHandler } from './weekly-recap.handler';

/** Weekly recap (Plus): GET /recap/weekly. The handler is here too so the in-process runner works without Redis. */
@Module({
  imports: [TrackingModule, PlansModule],
  controllers: [RecapController],
  providers: [RecapService, WeeklyRecapHandler],
})
export class RecapModule {}
