import { Module } from '@nestjs/common';
import { PlanNarrativeHandler } from './plan-narrative.handler';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';

@Module({ controllers: [PlansController], providers: [PlansService, PlanNarrativeHandler], exports: [PlansService] })
export class PlansModule {}

/** Worker role: only the plan narrative job handler (queue `ai`). */
@Module({ providers: [PlanNarrativeHandler] })
export class PlansWorkerModule {}
