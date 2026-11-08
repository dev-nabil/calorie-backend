import { Module } from '@nestjs/common';
import { WeeklyRecapHandler } from './weekly-recap.handler';

/** Worker role: the weekly recap job handler (queue `ai`). */
@Module({ providers: [WeeklyRecapHandler] })
export class RecapWorkerModule {}
