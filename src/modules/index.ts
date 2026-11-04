import { AuthModule } from './auth/auth.module';
import { ContentModule } from './content/content.module';
import { HealthModule } from './health/health.module';
import { UsersModule } from './users/users.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { PlansModule } from './plans/plans.module';
import { TrackingModule } from './tracking/tracking.module';
import { PublicModule } from './public/public.module';
import { AiModule } from './ai/ai.module';
import { ScansModule } from './scans/scans.module';
import { AppConfigModule } from './app-config/app-config.controller';
import { BillingModule } from './billing/billing.module';
import { UploadsModule } from './uploads/uploads.module';
import { MealParseModule } from './meal-parse/meal-parse.module';
import { ConversationsModule } from './conversations/conversations.module';
import { AdminModule } from './admin/admin.module';
import { AccountModule } from './account/account.module';
import { VoiceModule } from './voice/voice.module';
import { RemindersModule } from './reminders/reminders.module';
import { ReconcileModule } from '../jobs/reconcile';

/** Feature modules served by the API role. */
export const FEATURE_MODULES = [HealthModule, ContentModule, UsersModule, AuthModule, OnboardingModule, PlansModule, TrackingModule, PublicModule, AiModule, ScansModule, AppConfigModule, BillingModule, UploadsModule, MealParseModule, ConversationsModule, AdminModule, AccountModule, VoiceModule, RemindersModule, ReconcileModule];
