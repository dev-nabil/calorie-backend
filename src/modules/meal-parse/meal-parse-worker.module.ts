import { Module } from '@nestjs/common';
import { MealParseHandler } from './meal-parse.handler';

/** Worker role: only the handler. */
@Module({ providers: [MealParseHandler] })
export class MealParseWorkerModule {}
