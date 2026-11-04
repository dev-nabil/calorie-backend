import { Module } from '@nestjs/common';
import { MealParseController } from './meal-parse.controller';
import { MealParseHandler } from './meal-parse.handler';

@Module({ controllers: [MealParseController], providers: [MealParseHandler] })
export class MealParseModule {}
