import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module';
import { DailyLogsService } from './daily-logs.service';
import { DaysService } from './days.service';
import { MealsService } from './meals.service';
import { DaysController, MealsController, ProgressController, WeightsController } from './tracking.controllers';
import { WeightsService } from './weights.service';

@Module({
  imports: [PlansModule],
  controllers: [MealsController, DaysController, WeightsController, ProgressController],
  providers: [DailyLogsService, MealsService, DaysService, WeightsService],
  exports: [DailyLogsService, MealsService, DaysService],
})
export class TrackingModule {}
