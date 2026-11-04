import { Module } from '@nestjs/common';
import { ExtractionHandler } from './extraction.handler';
import { ConversationSummaries } from './services/conversation-summaries.service';

/** Worker role: extraction handler for queue `ai`. */
@Module({ providers: [ExtractionHandler, ConversationSummaries] })
export class ConversationsWorkerModule {}
