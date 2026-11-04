import { Module } from '@nestjs/common';
import { PlanNarrativeHandler } from './plan-narrative.handler';

/** Worker role: only the plan narrative job handler (queue `ai`). */
@Module({ providers: [PlanNarrativeHandler] })
export class PlansWorkerModule {}
