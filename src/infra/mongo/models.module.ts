import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiUsageDailySchema } from '../../modules/ai/schemas/ai.schema';
import { OtpCodeSchema, SessionSchema } from '../../modules/auth/schemas/auth.schema';
import { AbuseEventSchema, ScanSchema } from '../../modules/scans/schemas/scans.schema';
import { ConversationSchema, MessageSchema } from '../../modules/conversations/schemas/conversations.schema';
import { AdminUserSchema, AuditLogSchema } from '../../modules/admin/schemas/admin.schema';
import { DeletionRequestDbSchema, WaitlistSchema } from '../../modules/public/schemas/public.schema';
import { BillingEventSchema, SubscriptionSchema } from '../../modules/billing/schemas/billing.schema';
import { ReminderSchema } from '../../modules/reminders/schemas/reminders.schema';
import { ReconcileRunSchema } from '../../jobs/reconcile';
import { AiPromptSchema, AppConfigSchema, ContentVersionSchema } from '../../modules/content/schemas/content.schema';
import { OnboardingAnswerSchema, ProfileSchema } from '../../modules/onboarding/schemas/onboarding.schema';
import { PlanDraftSchema, PlanSchema } from '../../modules/plans/schemas/plans.schema';
import { DailyLogSchema, MealSchema, WeightLogSchema } from '../../modules/tracking/schemas/tracking.schema';
import { DeviceSchema, ScanLedgerSchema, UserSchema } from '../../modules/users/schemas/users.schema';

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
