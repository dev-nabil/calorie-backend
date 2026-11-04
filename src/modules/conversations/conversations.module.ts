import { Module } from '@nestjs/common';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { TrackingModule } from '../tracking/tracking.module';
import { CoachService } from './services/coach.service';
import { ExtractionHandler } from './extraction.handler';
import { OnboardingTurnsService } from './services/onboarding-turns.service';
import { RealtimeService } from './services/realtime.service';
import { ConversationSummaries } from './services/conversation-summaries.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './services/conversations.service';

@Module({
  imports: [OnboardingModule, TrackingModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, OnboardingTurnsService, RealtimeService, CoachService, ExtractionHandler, ConversationSummaries],
})
export class ConversationsModule {}
