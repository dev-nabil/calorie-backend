import { Module } from '@nestjs/common';
import { CoachPreferencesModule } from '../coach-preferences/coach-preferences.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { TrackingModule } from '../tracking/tracking.module';
import { RecapModule } from '../recap/recap.module';
import { RecipesModule } from '../recipes/recipes.module';
import { RemindersModule } from '../reminders/reminders.module';
import { ActionsService } from './services/actions.service';
import { BuddyService } from './services/buddy.service';
import { DraftsService } from './services/drafts.service';
import { CoachService } from './services/coach.service';
import { ExtractionHandler } from './extraction.handler';
import { OnboardingTurnsService } from './services/onboarding-turns.service';
import { RealtimeService } from './services/realtime.service';
import { ConversationSummaries } from './services/conversation-summaries.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './services/conversations.service';

@Module({
  imports: [OnboardingModule, TrackingModule, CoachPreferencesModule, RecipesModule, RemindersModule, RecapModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, OnboardingTurnsService, RealtimeService, CoachService, ExtractionHandler, ConversationSummaries, DraftsService, ActionsService, BuddyService],
})
export class ConversationsModule {}
