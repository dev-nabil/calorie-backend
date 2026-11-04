import { Module } from '@nestjs/common';
import { AiWorker } from './ai-worker.service';

/** Worker role: processes queue `ai` (meal parse, onboarding extraction). */
@Module({ providers: [AiWorker] })
export class AiWorkerModule {}
