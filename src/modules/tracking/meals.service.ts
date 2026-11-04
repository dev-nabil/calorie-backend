import { clock } from '../../common/clock';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobHandlers, JobQueue } from '../../jobs/background-jobs';
import { makeThumbnails, thumbKey } from '../media/thumbnails';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import {
  ERROR_CODES,
  MEAL_RESTORE_WINDOW_DAYS,
  type CreateMealRequest,
  type Meal,
  type MealItemInput,
  type UpdateMealRequest,
} from '../../shared';
import { diffDays, resolveEntryDay } from '../../domain/day-keys';
import { computeTotals, scaleItem } from '../../domain/nutrition-validator';
import { ApiError } from '../../common/errors/api-error';
import { DailyLogsService } from './daily-logs.service';
import { StorageService } from '../../infra/storage/storage';
import { ownsKey } from '../uploads/uploads.module';
import type { MealDoc, StoredMealItem } from './tracking.schemas';

const r1 = (n: number) => Math.round(n * 10) / 10;
const RESTORE_MS = MEAL_RESTORE_WINDOW_DAYS * 86_400_000;
export const THUMBNAIL_JOB = 'meal_thumbnail';

export interface MealPhotoSource {
  /** Looks up a succeeded scan of this user for the photo reference (scans module). */
  photoFor(userId: Types.ObjectId, scanId: string): Promise<{ key: string; thumbKey: string | null } | null>;
}

/** M3-T2: meals are the source of truth; every write recomputes the affected day (S-10). */
@Injectable()
export class MealsService implements OnModuleInit {
  private photoSource: MealPhotoSource | null = null;

  constructor(
    @InjectModel('Meal') private readonly meals: Model<MealDoc>,
    private readonly dailyLogs: DailyLogsService,
    private readonly storage: StorageService,
    private readonly handlers: JobHandlers,
    private readonly jobs: JobQueue,
  ) {}

  onModuleInit(): void {
    this.handlers.register(THUMBNAIL_JOB, (p) => this.thumbnail(p as { mealId: string; key: string }));
  }

  /** M4-T8 worker job: 320 px and 1024 px re-encoded copies; the meal then serves those. */
  async thumbnail({ mealId, key }: { mealId: string; key: string }): Promise<void> {
    const original = await this.storage.get(key);
    if (!original) return;
    const t = await makeThumbnails(original);
    await this.storage.put(thumbKey(key, 320), t[320], 'image/jpeg');
    await this.storage.put(thumbKey(key, 1024), t[1024], 'image/jpeg');
    await this.meals.updateOne({ _id: mealId, 'photo.key': key }, { $set: { 'photo.thumbKey': thumbKey(key, 320), 'photo.displayKey': thumbKey(key, 1024) } });
  }

  setPhotoSource(source: MealPhotoSource): void {
    this.photoSource = source;
  }

  static storeItems(items: MealItemInput[]): StoredMealItem[] {
    return items.map((i) => ({
      name: i.name,
      grams: r1(i.grams),
      kcal: Math.round(i.kcal),
      proteinG: r1(i.proteinG),
      carbsG: r1(i.carbsG),
      fatG: r1(i.fatG),
      fiberG: i.fiberG === undefined ? null : r1(i.fiberG),
      confidence: i.confidence ?? null,
      edited: Boolean(i.edited),
      excluded: Boolean(i.excluded),
      addedByUser: Boolean(i.addedByUser),
    }));
  }

  async create(userId: string, req: CreateMealRequest, now = clock.now()): Promise<Meal> {
    const uid = new Types.ObjectId(userId);
    const day = resolveEntryDay({ loggedAt: new Date(req.loggedAt), timeZone: req.timezone, date: req.date, now });
    const multiplier = req.portionMultiplier ?? 1;
    const items = MealsService.storeItems(req.items);
    let photo = req.scanId && this.photoSource ? await this.photoSource.photoFor(uid, req.scanId) : null;
    if (!photo && req.imageKey) {
      if (!ownsKey(userId, 'meal_photo', req.imageKey) || !(await this.storage.exists(req.imageKey))) {
        throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Upload the photo with POST /uploads/presign first', 400, { field: 'imageKey' });
      }
      photo = { key: req.imageKey, thumbKey: null };
    }
    let doc;
    try {
      doc = await this.meals.create({
        userId: uid,
        date: day.date,
        timezone: day.timezone,
        loggedAt: new Date(req.loggedAt),
        category: req.category,
        name: req.name,
        source: req.source,
        scanId: req.scanId ?? null,
        photo,
        portionMultiplier: multiplier,
        items,
        totals: computeTotals(items, multiplier),
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        throw ApiError.conflict(ERROR_CODES.CONFLICT, 'A meal was already saved from this scan', { scanId: req.scanId });
      }
      throw e;
    }
    await this.dailyLogs.recompute(uid, day.date);
    if (photo) await this.jobs.enqueue(THUMBNAIL_JOB, { mealId: doc._id.toString(), key: photo.key }, { jobId: `thumb-${doc._id.toString()}` });
    return this.toMeal(doc.toObject() as MealDoc);
  }

  private async find(userId: string, id: string): Promise<MealDoc> {
    if (!Types.ObjectId.isValid(id)) throw ApiError.notFound(ERROR_CODES.MEAL_NOT_FOUND, 'Meal not found');
    const doc = await this.meals.findOne({ _id: id, userId: new Types.ObjectId(userId) }).lean<MealDoc>();
    if (!doc) throw ApiError.notFound(ERROR_CODES.MEAL_NOT_FOUND, 'Meal not found');
    return doc;
  }

  async update(userId: string, id: string, patch: UpdateMealRequest, now = clock.now()): Promise<Meal> {
    const meal = await this.find(userId, id);
    if (meal.deletedAt) throw ApiError.notFound(ERROR_CODES.MEAL_NOT_FOUND, 'Meal not found');
    const set: Partial<MealDoc> = {};
    if (patch.category) set.category = patch.category;
    if (patch.name) set.name = patch.name;
    if (patch.date || patch.timezone) {
      const day = resolveEntryDay({ loggedAt: meal.loggedAt, timeZone: patch.timezone ?? meal.timezone, date: patch.date ?? meal.date, now });
      set.date = day.date;
      set.timezone = day.timezone;
    }
    const items = patch.items ? MealsService.storeItems(patch.items) : meal.items;
    const multiplier = patch.portionMultiplier ?? meal.portionMultiplier;
    if (patch.items) set.items = items;
    if (patch.portionMultiplier !== undefined) set.portionMultiplier = multiplier;
    set.totals = computeTotals(items, multiplier);
    const updated = await this.meals.findOneAndUpdate({ _id: meal._id }, { $set: set }, { returnDocument: 'after' }).lean<MealDoc>();
    await this.dailyLogs.recompute(meal.userId, updated!.date);
    if (updated!.date !== meal.date) await this.dailyLogs.recompute(meal.userId, meal.date);
    return this.toMeal(updated!);
  }

  /** BR-17: soft delete; totals and streaks follow. */
  async remove(userId: string, id: string): Promise<Meal> {
    const meal = await this.find(userId, id);
    if (meal.deletedAt) return this.toMeal(meal);
    const updated = await this.meals.findOneAndUpdate({ _id: meal._id }, { $set: { deletedAt: clock.now() } }, { returnDocument: 'after' }).lean<MealDoc>();
    await this.dailyLogs.recompute(meal.userId, meal.date);
    return this.toMeal(updated!);
  }

  /** BR-17: restore within 7 days. */
  async restore(userId: string, id: string, now = clock.now()): Promise<Meal> {
    const meal = await this.find(userId, id);
    if (!meal.deletedAt) return this.toMeal(meal);
    if (now.getTime() - meal.deletedAt.getTime() > RESTORE_MS) {
      throw ApiError.conflict(ERROR_CODES.MEAL_RESTORE_EXPIRED, 'This meal can no longer be restored');
    }
    const updated = await this.meals.findOneAndUpdate({ _id: meal._id }, { $set: { deletedAt: null } }, { returnDocument: 'after' }).lean<MealDoc>();
    await this.dailyLogs.recompute(meal.userId, meal.date);
    return this.toMeal(updated!);
  }

  async list(userId: string, from: string, to: string, includeDeleted = false): Promise<Meal[]> {
    if (from > to) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, '`from` must not be after `to`');
    if (diffDays(from, to) > 92) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Range is limited to 93 days');
    const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId), date: { $gte: from, $lte: to } };
    if (!includeDeleted) filter.deletedAt = null;
    const docs = await this.meals.find(filter).sort({ date: 1, loggedAt: 1 }).lean<MealDoc[]>();
    return docs.map((d) => this.toMeal(d));
  }

  async forDay(userId: Types.ObjectId, date: string): Promise<MealDoc[]> {
    return this.meals.find({ userId, date, deletedAt: null }).sort({ loggedAt: 1 }).lean<MealDoc[]>();
  }

  toMeal(d: MealDoc): Meal {
    return {
      id: d._id.toString(),
      date: d.date,
      timezone: d.timezone,
      loggedAt: new Date(d.loggedAt).toISOString(),
      category: d.category,
      name: d.name,
      source: d.source,
      scanId: d.scanId ?? null,
      photo: d.photo
        ? {
            key: d.photo.key,
            thumbKey: d.photo.thumbKey ?? null,
            url: this.storage.signedGetUrl(d.photo.displayKey ?? d.photo.key),
            thumbUrl: d.photo.thumbKey ? this.storage.signedGetUrl(d.photo.thumbKey) : null,
          }
        : null,
      portionMultiplier: d.portionMultiplier,
      items: d.items.map((i) => {
        const s = scaleItem(i, d.portionMultiplier);
        return {
          ...i,
          fiberG: i.fiberG ?? null,
          confidence: i.confidence ?? null,
          scaled: { grams: r1(s.grams), kcal: Math.round(s.kcal), proteinG: r1(s.proteinG), carbsG: r1(s.carbsG), fatG: r1(s.fatG) },
        };
      }),
      totals: d.totals,
      deletedAt: d.deletedAt ? new Date(d.deletedAt).toISOString() : null,
      restorableUntil: d.deletedAt ? new Date(new Date(d.deletedAt).getTime() + RESTORE_MS).toISOString() : null,
      createdAt: new Date(d.createdAt).toISOString(),
      updatedAt: new Date(d.updatedAt).toISOString(),
    };
  }
}
