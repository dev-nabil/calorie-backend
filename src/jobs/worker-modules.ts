import type { DynamicModule, Type } from '@nestjs/common';
import { AiModule } from '../modules/ai/ai.module';
import { AiWorkerModule } from '../modules/ai/ai-worker.module';
import { MealParseWorkerModule } from '../modules/meal-parse/meal-parse-worker.module';
import { ConversationsWorkerModule } from '../modules/conversations/conversations-worker.module';
import { AccountWorkerModule } from '../modules/account/account-worker.module';
import { AuthModule } from '../modules/auth/auth.module';
import { VoiceWorkerModule } from '../modules/voice/voice-worker.module';
import { RemindersWorkerModule } from '../modules/reminders/reminders-worker.module';
import { ReconcileModule } from './reconcile';
import { IndexesModule } from './indexes';
import { ContentModule } from '../modules/content/content.module';
import { ScansWorkerModule } from '../modules/scans/scans-worker.module';
import { PlansWorkerModule } from '../modules/plans/plans-worker.module';
import { UsersModule } from '../modules/users/users.module';

/** Modules loaded by the worker role (ROLE=worker). */
export const WORKER_MODULES: Array<Type | DynamicModule> = [ContentModule, UsersModule, AiModule, AiWorkerModule, ScansWorkerModule, MealParseWorkerModule, PlansWorkerModule, ConversationsWorkerModule, AuthModule, AccountWorkerModule, VoiceWorkerModule, RemindersWorkerModule, ReconcileModule, IndexesModule];
