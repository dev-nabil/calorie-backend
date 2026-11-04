import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiUsageDailySchema } from '../../modules/ai/ai.schemas';
import { OtpCodeSchema, SessionSchema } from '../../modules/auth/auth.schemas';
import { AbuseEventSchema, ScanSchema } from '../../modules/scans/scans.schemas';
import { ConversationSchema, MessageSchema } from '../../modules/conversations/conversations.schemas';
import { AdminUserSchema, AuditLogSchema } from '../../modules/admin/admin.schemas';
import { DeletionRequestDbSchema, WaitlistSchema } from '../../modules/public/public.schemas';
import { BillingEventSchema, SubscriptionSchema } from '../../modules/billing/billing.schemas';
import { ReminderSchema } from '../../modules/reminders/reminders.module';
import { ReconcileRunSchema } from '../../jobs/reconcile';
import { AiPromptSchema, AppConfigSchema, ContentVersionSchema } from '../../modules/content/content.schemas';
import { OnboardingAnswerSchema, ProfileSchema } from '../../modules/onboarding/onboarding.schemas';
import { PlanDraftSchema, PlanSchema } from '../../modules/plans/plans.schemas';
import { DailyLogSchema, MealSchema, WeightLogSchema } from '../../modules/tracking/tracking.schemas';
import { DeviceSchema, ScanLedgerSchema, UserSchema } from '../../modules/users/users.schemas';

/** Every collection, registered once (plan section 6). Inject with @InjectModel('<Name>'). */
export const MODEL_DEFINITIONS = [
  { name: 'User', schema: UserSchema },
  { name: 'Device', schema: DeviceSchema },
  { name: 'ScanLedger', schema: ScanLedgerSchema },
  { name: 'Session', schema: SessionSchema },
  { name: 'OtpCode', schema: OtpCodeSchema },
  { name: 'ContentVersion', schema: ContentVersionSchema },
  { name: 'AiPrompt', schema: AiPromptSchema },
  { name: 'AppConfig', schema: AppConfigSchema },
  { name: 'Profile', schema: ProfileSchema },
  { name: 'OnboardingAnswer', schema: OnboardingAnswerSchema },
  { name: 'Plan', schema: PlanSchema },
  { name: 'PlanDraft', schema: PlanDraftSchema },
  { name: 'Meal', schema: MealSchema },
  { name: 'DailyLog', schema: DailyLogSchema },
  { name: 'WeightLog', schema: WeightLogSchema },
  { name: 'AiUsageDaily', schema: AiUsageDailySchema },
  { name: 'Scan', schema: ScanSchema },
  { name: 'AbuseEvent', schema: AbuseEventSchema },
  { name: 'Conversation', schema: ConversationSchema },
  { name: 'Message', schema: MessageSchema },
  { name: 'AdminUser', schema: AdminUserSchema },
  { name: 'AuditLog', schema: AuditLogSchema },
  { name: 'Waitlist', schema: WaitlistSchema },
  { name: 'DeletionRequest', schema: DeletionRequestDbSchema },
  { name: 'Subscription', schema: SubscriptionSchema },
  { name: 'BillingEvent', schema: BillingEventSchema },
  { name: 'Reminder', schema: ReminderSchema },
  { name: 'ReconcileRun', schema: ReconcileRunSchema },
];

const models = MongooseModule.forFeature(MODEL_DEFINITIONS);

@Global()
@Module({ imports: [models], exports: [models] })
export class ModelsModule {}
