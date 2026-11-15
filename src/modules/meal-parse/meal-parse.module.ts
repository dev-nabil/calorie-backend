import { Module } from '@nestjs/common';
import { MealDescribeHandler } from './meal-describe.handler';
import { MealParseController } from './meal-parse.controller';
import { MealParseHandler } from './meal-parse.handler';
import { MealTranscribeHandler } from './meal-transcribe.handler';

@Module({ controllers: [MealParseController], providers: [MealParseHandler, MealDescribeHandler, MealTranscribeHandler] })
export class MealParseModule {}
