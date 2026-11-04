import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module';
import { DailyLogsService } from './services/daily-logs.service';
import { DaysService } from './services/days.service';
import { MealsService } from './services/meals.service';
import { DaysController } from './controllers/days.controller';
import { MealsController } from './controllers/meals.controller';
import { ProgressController } from './controllers/progress.controller';
import { WeightsController } from './controllers/weights.controller';
import { WeightsService } from './services/weights.service';

@Module({
  imports: [PlansModule],
  controllers: [MealsController, DaysController, WeightsController, ProgressController],
  providers: [DailyLogsService, MealsService, DaysService, WeightsService],
  exports: [DailyLogsService, MealsService, DaysService],
})
export class TrackingModule {}
