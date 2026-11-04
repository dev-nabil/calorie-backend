import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { ERROR_CODES } from '../../shared';
import { clock } from '../../common/clock';
import { ApiError } from '../../common/errors/api-error';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.service';
import { JobHandlers, JobQueue } from '../../jobs/background-jobs';
import { StorageService } from '../../infra/storage/storage';
import { EmailSender } from '../auth/providers';
import { DELETION_GRACE_DAYS } from '../users/users.service';
import type { UserDoc } from '../users/users.schemas';

export const EXPORT_JOB = 'account_export';
export const PURGE_JOB = 'account_purge';
const EXPORT_LINK_SEC = 24 * 3600;

/** Collections holding a user's personal data, purged after 30 days (BR-13). */
const USER_DATA_MODELS = ['Profile', 'OnboardingAnswer', 'Plan', 'PlanDraft', 'Meal', 'DailyLog', 'WeightLog', 'Scan', 'Conversation', 'Message', 'Device', 'Session', 'Reminder'] as const;

/** M1-T5: data export (worker job, link by email) and the purge job (BR-13). */
@Injectable()
export class AccountService implements OnModuleInit {
  private readonly logger = new Logger('AccountJobs');

  constructor(
    @InjectModel('User') private readonly users: Model<UserDoc>,
    @InjectModel('Profile') private readonly profiles: Model<unknown>,
    @InjectModel('OnboardingAnswer') private readonly answers: Model<unknown>,
    @InjectModel('Plan') private readonly plans: Model<unknown>,
    @InjectModel('PlanDraft') private readonly planDrafts: Model<unknown>,
    @InjectModel('Meal') private readonly meals: Model<unknown>,
    @InjectModel('DailyLog') private readonly logs: Model<unknown>,
    @InjectModel('WeightLog') private readonly weights: Model<unknown>,
    @InjectModel('Scan') private readonly scans: Model<unknown>,
    @InjectModel('Conversation') private readonly conversations: Model<unknown>,
    @InjectModel('Message') private readonly messages: Model<unknown>,
    @InjectModel('Device') private readonly devices: Model<unknown>,
    private readonly handlers: JobHandlers,
    private readonly queue: JobQueue,
    private readonly storage: StorageService,
    private readonly email: EmailSender,
    private readonly limiter: RateLimiter,
  ) {}

  onModuleInit(): void {
    this.handlers.register(EXPORT_JOB, (p) => this.buildExport(p as { userId: string; exportId: string }));
    this.handlers.register(PURGE_JOB, () => this.purge(), 24 * 3600_000);
  }

  async requestExport(userId: string): Promise<{ exportId: string }> {
    await this.limiter.consume({ key: `export:user:${userId}`, limit: 3, windowSec: 24 * 3600 });
    const exportId = randomUUID();
    await this.queue.enqueue(EXPORT_JOB, { userId, exportId }, { jobId: exportId });
    return { exportId };
  }

  /** Every personal record as JSON, uploaded privately and linked by email (signed, 24 h). */
  async buildExport({ userId, exportId }: { userId: string; exportId: string }): Promise<string> {
    const uid = new Types.ObjectId(userId);
    const user = await this.users.findById(uid).lean<UserDoc>();
    if (!user) return '';
    const strip = (docs: unknown[]) => docs.map((d) => ({ ...(d as object), __v: undefined }));
    const sessionsFree = { userId: uid };
    const [profile, answers, plans, planDrafts, meals, logs, weights, scans, conversations, messages, devices] = await Promise.all([
      this.profiles.findOne(sessionsFree).lean(),
      this.answers.find(sessionsFree).lean(),
      this.plans.find(sessionsFree).lean(),
      this.planDrafts.find(sessionsFree).lean(),
      this.meals.find(sessionsFree).lean(),
      this.logs.find(sessionsFree).lean(),
      this.weights.find(sessionsFree).lean(),
      this.scans.find(sessionsFree, { rawOutput: 0 }).lean(),
      this.conversations.find(sessionsFree).lean(),
      this.messages.find(sessionsFree).lean(),
      this.devices.find(sessionsFree, { 'integrity.publicKeyPem': 0, pushToken: 0 }).lean(),
    ]);
    const body = {
      exportedAt: clock.now().toISOString(),
      format: 'nouri-export-v1',
      user: { ...user, authProviders: user.authProviders.map((p) => ({ provider: p.provider, linkedAt: p.linkedAt })) },
      profile,
      onboardingAnswers: strip(answers),
      plans: strip(plans),
      planDrafts: strip(planDrafts),
      meals: strip(meals),
      dailyLogs: strip(logs),
      weights: strip(weights),
      scans: strip(scans),
      conversations: strip(conversations),
      messages: strip(messages),
      devices: strip(devices),
    };
    const key = `u/${userId}/export/${exportId}.json`;
    await this.storage.put(key, Buffer.from(JSON.stringify(body, null, 2)), 'application/json');
    const url = this.storage.signedGetUrl(key, EXPORT_LINK_SEC);
    await this.email.sendLink(user.email, 'export', url);
    return key;
  }

  /**
   * BR-13: 30 days after DELETE /me, remove personal data and files. Kept: scan_ledger (HMAC of the
   * email, BR-01) and store billing records (subscriptions, billing_events) required by law. The
   * user document becomes an anonymous tombstone so billing records keep their reference.
   */
  async purge(now = clock.now()): Promise<number> {
    const cutoff = new Date(now.getTime() - DELETION_GRACE_DAYS * 86_400_000);
    const due = await this.users.find({ status: 'pending_deletion', deletionRequestedAt: { $lte: cutoff } }, { _id: 1 }).limit(500).lean<{ _id: Types.ObjectId }[]>();
    for (const { _id } of due) {
      for (const name of USER_DATA_MODELS) {
        const model = this.users.db.models[name];
        if (model) await model.deleteMany({ userId: _id });
      }
      await this.storage.deletePrefix(`u/${_id.toString()}/`);
      await this.users.updateOne(
        { _id },
        {
          $set: {
            status: 'deleted',
            email: `deleted+${_id.toString()}@deleted.invalid`,
            emailVerifiedAt: null,
            authProviders: [],
            displayName: null,
            consents: {},
            experiments: {},
            freeScans: { allowance: 0, used: 0 },
          },
        },
      );
      this.logger.log({ userId: _id.toString() }, 'account purged');
    }
    return due.length;
  }
}

export function assertExportAllowed(user: UserDoc): void {
  if (user.status !== 'active') throw ApiError.forbidden(ERROR_CODES.ACCOUNT_DELETED, 'This account is being deleted');
}
