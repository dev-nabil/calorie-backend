import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Schema, type Model, type Types } from 'mongoose';
import { addDays, dayKeyFor } from '../domain/day-keys';
import { clock } from '../common/clock';
import { DailyLogsService } from '../modules/tracking/daily-logs.service';
import { TrackingModule } from '../modules/tracking/tracking.module';
import { PlansModule } from '../modules/plans/plans.module';
import type { DailyLogDoc } from '../modules/tracking/tracking.schemas';
import { JobHandlers } from './background-jobs';

export const RECONCILE_JOB = 'daily_logs_reconcile';

export const ReconcileRunSchema = new Schema(
  { at: Date, users: Number, checked: Number, drifted: Number, samples: { type: Schema.Types.Mixed, default: [] } },
  { collection: 'reconcile_runs', timestamps: true },
);
ReconcileRunSchema.index({ at: -1 });

/** S-10 / M3-T1: nightly recompute of the last 3 days for active users; drift is logged and stored. */
@Injectable()
export class ReconcileService implements OnModuleInit {
  private readonly logger = new Logger('Reconcile');
  constructor(
    @InjectModel('User') private readonly users: Model<{ _id: Types.ObjectId; timezone: string; lastActiveAt: Date | null; status: string }>,
    @InjectModel('DailyLog') private readonly logs: Model<DailyLogDoc>,
    @InjectModel('ReconcileRun') private readonly runs: Model<{ at: Date; users: number; checked: number; drifted: number; samples: unknown[] }>,
    private readonly dailyLogs: DailyLogsService,
    private readonly handlers: JobHandlers,
  ) {}

  onModuleInit(): void {
    this.handlers.register(RECONCILE_JOB, () => this.run(), 24 * 3600_000);
  }

  async run(now = clock.now()): Promise<{ users: number; checked: number; drifted: number }> {
    const active = await this.users.find({ status: 'active', lastActiveAt: { $gte: new Date(now.getTime() - 3 * 86_400_000) } }, { timezone: 1 }).lean();
    let checked = 0;
    const samples: unknown[] = [];
    for (const u of active) {
      const today = dayKeyFor(now, u.timezone || 'UTC');
      for (const date of [addDays(today, -2), addDays(today, -1), today]) {
        const before = await this.logs.findOne({ userId: u._id, date }).lean<DailyLogDoc>();
        const after = await this.dailyLogs.recompute(u._id, date);
        checked++;
        if (before && (Math.round(before.totals.kcal) !== Math.round(after.totals.kcal) || before.mealsCount !== after.mealsCount)) {
          samples.push({ userId: u._id.toString(), date, before: { kcal: before.totals.kcal, meals: before.mealsCount }, after: { kcal: after.totals.kcal, meals: after.mealsCount } });
        }
      }
    }
    const result = { users: active.length, checked, drifted: samples.length };
    await this.runs.create({ at: now, ...result, samples: samples.slice(0, 50) });
    if (samples.length) this.logger.warn(result, 'daily_logs drift found and repaired');
    else this.logger.log(result, 'daily_logs reconcile: no drift');
    return result;
  }
}

@Module({ imports: [TrackingModule, PlansModule], providers: [ReconcileService], exports: [ReconcileService] })
export class ReconcileModule {}
