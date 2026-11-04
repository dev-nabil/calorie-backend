import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { ERROR_CODES, WATER_STEP_ML } from '../../../shared';
import { ApiError } from '../../../common/errors/api-error';
import type { DailyLogDoc, MealDoc } from '../schemas/tracking.schema';

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * daily_logs is a derived cache (S-10): recomputed from meals for one user and day on every
 * meal write (one indexed aggregate, one upsert). Water lives only here.
 */
@Injectable()
export class DailyLogsService {
  constructor(
    @InjectModel('DailyLog') private readonly logs: Model<DailyLogDoc>,
    @InjectModel('Meal') private readonly meals: Model<MealDoc>,
  ) {}

  async recompute(userId: Types.ObjectId, date: string): Promise<DailyLogDoc> {
    const [agg] = await this.meals.aggregate<{ kcal: number; proteinG: number; carbsG: number; fatG: number; count: number }>([
      { $match: { userId, date, deletedAt: null } },
      {
        $group: {
          _id: null,
          kcal: { $sum: '$totals.kcal' },
          proteinG: { $sum: '$totals.proteinG' },
          carbsG: { $sum: '$totals.carbsG' },
          fatG: { $sum: '$totals.fatG' },
          count: { $sum: 1 },
        },
      },
    ]);
    const count = agg?.count ?? 0;
    const doc = await this.logs
      .findOneAndUpdate(
        { userId, date },
        {
          $set: {
            totals: { kcal: Math.round(agg?.kcal ?? 0), proteinG: r1(agg?.proteinG ?? 0), carbsG: r1(agg?.carbsG ?? 0), fatG: r1(agg?.fatG ?? 0) },
            mealsCount: count,
            logged: count > 0,
            recomputedAt: new Date(),
          },
        },
        { upsert: true, returnDocument: 'after' },
      )
      .lean<DailyLogDoc>();
    return doc!;
  }

  async get(userId: Types.ObjectId, date: string): Promise<DailyLogDoc | null> {
    return this.logs.findOne({ userId, date }).lean<DailyLogDoc>();
  }

  async range(userId: Types.ObjectId, from: string, to: string): Promise<DailyLogDoc[]> {
    return this.logs.find({ userId, date: { $gte: from, $lte: to } }).sort({ date: 1 }).lean<DailyLogDoc[]>();
  }

  async loggedDays(userId: Types.ObjectId, from: string, to: string): Promise<string[]> {
    const docs = await this.logs.find({ userId, logged: true, date: { $gte: from, $lte: to } }, { date: 1 }).lean<{ date: string }[]>();
    return docs.map((d) => d.date);
  }

  /** BR-09: water in 250 ml steps; an undo never takes the day below zero. */
  async addWater(userId: Types.ObjectId, date: string, ml: number, at: Date, timezone: string): Promise<DailyLogDoc> {
    if (ml % WATER_STEP_ML !== 0) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Water changes in 250 ml steps');
    await this.logs.updateOne({ userId, date }, { $setOnInsert: { userId, date } }, { upsert: true });
    const filter = ml < 0 ? { userId, date, waterMl: { $gte: -ml } } : { userId, date };
    const doc = await this.logs
      .findOneAndUpdate(filter, { $inc: { waterMl: ml }, $push: { waterEntries: { ml, at, timezone } } }, { returnDocument: 'after' })
      .lean<DailyLogDoc>();
    if (!doc) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'There is no water to undo for this day', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return doc;
  }
}
