import { Module } from '@nestjs/common';
import { FridgeChefHandler } from './fridge-chef.handler';

/** Worker role: the fridge chef job handler (queue `ai`). */
@Module({ providers: [FridgeChefHandler] })
export class FridgeChefWorkerModule {}
