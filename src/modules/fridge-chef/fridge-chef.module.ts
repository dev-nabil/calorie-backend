import { Module } from '@nestjs/common';
import { FridgeChefController } from './fridge-chef.controller';
import { FridgeChefHandler } from './fridge-chef.handler';

/** Fridge chef (Plus): POST /fridge-chef. */
@Module({ controllers: [FridgeChefController], providers: [FridgeChefHandler] })
export class FridgeChefModule {}
