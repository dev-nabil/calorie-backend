import { clock } from '../../common/clock';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import type { CreateWeightRequest, WeightEntry } from '../../shared';
import { resolveEntryDay } from '../../domain/day-keys';
import { UsersService } from '../users/users.service';
import type { WeightLogDoc } from './tracking.schemas';

/** Weigh-ins (M3-T2); each stores its own timezone and day key (BR-07). */
@Injectable()
export class WeightsService {
  constructor(
    @InjectModel('WeightLog') private readonly weights: Model<WeightLogDoc>,
    private readonly users: UsersService,
  ) {}

  async create(userId: string, req: CreateWeightRequest, now = clock.now()): Promise<WeightEntry> {
    await this.users.requireActive(userId);
    const loggedAt = req.loggedAt ? new Date(req.loggedAt) : now;
    const day = resolveEntryDay({ loggedAt, timeZone: req.timezone, date: req.date, now });
    const doc = await this.weights.create({
      userId: new Types.ObjectId(userId),
      date: day.date,
      timezone: day.timezone,
      loggedAt,
      weightKg: Math.round(req.weightKg * 10) / 10,
      isEstimate: Boolean(req.isEstimate),
      source: 'manual',
    });
    return this.toEntry(doc.toObject() as WeightLogDoc);
  }

  async list(userId: string, q: { from?: string; to?: string; limit?: number }): Promise<WeightEntry[]> {
    const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
    if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    const docs = await this.weights.find(filter).sort({ date: -1, loggedAt: -1 }).limit(q.limit ?? 100).lean<WeightLogDoc[]>();
    return docs.map((d) => this.toEntry(d));
  }

  toEntry(d: WeightLogDoc): WeightEntry {
    return {
      id: d._id.toString(),
      date: d.date,
      timezone: d.timezone,
      loggedAt: new Date(d.loggedAt).toISOString(),
      weightKg: d.weightKg,
      isEstimate: d.isEstimate,
      source: d.source,
      createdAt: new Date(d.createdAt).toISOString(),
    };
  }
}
