import { clock } from '../../../common/clock';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobHandlers, JobQueue } from '../../../jobs/jobs.module';
import { makeThumbnails, thumbKey } from '../../../infra/media/thumbnails';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import {
  ERROR_CODES,
  MEAL_RESTORE_WINDOW_DAYS,
  type AnalysedItem,
  type CreateMealRequest,
  type Meal,
  type MealItemInput,
  type MealTotals,
  type NutrientValues,
  type NutritionSource,
  type RichInKey,
  type UpdateMealRequest,
} from '../../../shared';
import { diffDays, resolveEntryDay } from '../../../domain/day-keys';
import { ADJUSTED_ESTIMATE, AI_ESTIMATE, USER_ENTERED, applyItemCorrection, computeMealTotals, nutrientsForGrams, type FoodIndex } from '../../../domain/food-nutrition';
import { scaleItem } from '../../../domain/nutrition-validator';
import { FoodRecordsService } from '../../content/food-records.service';
import { ApiError } from '../../../common/errors/api-error';
import { DailyLogsService } from './daily-logs.service';
import { StorageService } from '../../../infra/storage/storage';
import { ownsKey } from '../../uploads/uploads.keys';
import type { MealDoc, StoredMealItem } from '../schemas/tracking.schema';

const r1 = (n: number) => Math.round(n * 10) / 10;
const r1OrNull = (n: number | null | undefined) => (n === null || n === undefined ? null : r1(n));
const r0OrNull = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n));
const RESTORE_MS = MEAL_RESTORE_WINDOW_DAYS * 86_400_000;
export const THUMBNAIL_JOB = 'meal_thumbnail';

export interface MealPhotoSource {
  /** Looks up a succeeded scan of this user for the photo reference (scans module). */
  photoFor(userId: Types.ObjectId, scanId: string): Promise<{ key: string; thumbKey: string | null } | null>;
  /** The stored analysis: the only trusted basis for items saved from a scan. */
  itemsFor(userId: Types.ObjectId, scanId: string): Promise<AnalysedItem[] | null>;
}

/** A packaged product's basis for an item saved with `barcode` (foods module). */
export interface ProductBasis {
  per100g: NutrientValues;
  source: NutritionSource;
  richIn: RichInKey[];
}

export interface MealProductSource {
  /** Cached product or the user's own label scan for this barcode; never calls an outside service. */
  basisFor(userId: Types.ObjectId, barcode: string): Promise<ProductBasis | null>;
}

interface StoreContext {
  /** Products for items sent with a barcode. */
  products?: Map<string, ProductBasis>;
  /** Items of the scan this meal comes from. */
  scan?: AnalysedItem[] | null;
  /** The meal's current items, on an edit. */
  prior?: StoredMealItem[];
  records?: FoodIndex;
}

function fromScanItem(item: AnalysedItem, input: MealItemInput): StoredMealItem {
  return {
    name: item.name,
    grams: item.grams,
    kcal: item.kcal,
    proteinG: item.proteinG,
    carbsG: item.carbsG,
    fatG: item.fatG,
    fiberG: item.fiberG,
    sugarG: item.sugarG,
    sodiumMg: item.sodiumMg,
    preparation: item.preparation,
    scanItemId: item.id,
    per100g: item.per100g,
    source: item.source,
    otherNutrients: item.otherNutrients,
    richIn: item.richIn ?? [],
    confidence: item.confidence,
    edited: Boolean(input.edited),
    excluded: Boolean(input.excluded),
    addedByUser: false,
  };
}

/** M3-T2: meals are the source of truth; every write recomputes the affected day (S-10). */
@Injectable()
export class MealsService implements OnModuleInit {
  private photoSource: MealPhotoSource | null = null;
  private productSource: MealProductSource | null = null;

  constructor(
    @InjectModel('Meal') private readonly meals: Model<MealDoc>,
    private readonly dailyLogs: DailyLogsService,
    private readonly storage: StorageService,
    private readonly handlers: JobHandlers,
    private readonly jobs: JobQueue,
    private readonly records: FoodRecordsService,
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

  setProductSource(source: MealProductSource): void {
    this.productSource = source;
  }

  /** Bases for every barcode in the items; unknown barcodes are left out and those items keep their own numbers. */
  private async productsFor(userId: Types.ObjectId, items: MealItemInput[]): Promise<Map<string, ProductBasis>> {
    const out = new Map<string, ProductBasis>();
    if (!this.productSource) return out;
    for (const code of new Set(items.map((i) => i.barcode).filter((c): c is string => Boolean(c)))) {
      const basis = await this.productSource.basisFor(userId, code);
      if (basis) out.set(code, basis);
    }
    return out;
  }

  /**
   * Item values always come from a per-100-gram basis when one exists: the stored scan first, then
   * the item's own. Numbers in the request are used only for entries that have no basis.
   */
  static storeItems(items: MealItemInput[], ctx: StoreContext = {}): StoredMealItem[] {
    return items.map((i) => {
      const scanned = i.scanItemId ? ctx.scan?.find((s) => s.id === i.scanItemId) : undefined;
      if (scanned && ctx.records) {
        const correction = { name: i.name, grams: i.grams, ...(i.preparation ? { preparation: i.preparation } : {}) };
        return fromScanItem(applyItemCorrection(scanned, correction, ctx.records).item, i);
      }
      const product = i.barcode ? ctx.products?.get(i.barcode) : undefined;
      if (product) {
        const grams = r1(i.grams);
        return {
          name: i.name,
          grams,
          ...nutrientsForGrams(product.per100g, grams),
          preparation: null,
          scanItemId: null,
          per100g: product.per100g,
          source: product.source,
          otherNutrients: [],
          richIn: product.richIn,
          confidence: i.confidence ?? null,
          edited: Boolean(i.edited),
          excluded: Boolean(i.excluded),
          addedByUser: Boolean(i.addedByUser),
        };
      }
      const prior = i.scanItemId ? ctx.prior?.find((p) => p.scanItemId === i.scanItemId) : undefined;
      const per100g = i.per100g ?? prior?.per100g ?? null;
      const grams = r1(i.grams);
      const stated = {
        kcal: r0OrNull(i.kcal),
        proteinG: r1OrNull(i.proteinG),
        carbsG: r1OrNull(i.carbsG),
        fatG: r1OrNull(i.fatG),
        fiberG: r1OrNull(i.fiberG),
        sugarG: r1OrNull(i.sugarG),
        sodiumMg: r0OrNull(i.sodiumMg),
      };
      const renamed = prior !== undefined && prior.name !== i.name;
      return {
        name: i.name,
        grams,
        ...(per100g ? nutrientsForGrams(per100g, grams) : stated),
        preparation: i.preparation ?? prior?.preparation ?? null,
        scanItemId: i.scanItemId ?? null,
        per100g,
        source: renamed ? ADJUSTED_ESTIMATE : (prior?.source ?? (i.per100g ? AI_ESTIMATE : USER_ENTERED)),
        otherNutrients: prior && prior.grams > 0 ? prior.otherNutrients.map((o) => ({ ...o, amount: r1((o.amount * grams) / prior.grams) })) : [],
        richIn: prior && !renamed ? (prior.richIn ?? []) : [],
        confidence: i.confidence ?? null,
        edited: Boolean(i.edited),
        excluded: Boolean(i.excluded),
        addedByUser: Boolean(i.addedByUser),
      };
    });
  }

  async create(userId: string, req: CreateMealRequest, now = clock.now()): Promise<Meal> {
    const uid = new Types.ObjectId(userId);
    const day = resolveEntryDay({ loggedAt: new Date(req.loggedAt), timeZone: req.timezone, date: req.date, now });
    const multiplier = req.portionMultiplier ?? 1;
    const scan = req.scanId && this.photoSource ? await this.photoSource.itemsFor(uid, req.scanId) : null;
    const items = MealsService.storeItems(req.items, { scan, records: this.records.index, products: await this.productsFor(uid, req.items) });
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
        totals: computeMealTotals(items, multiplier),
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
    const scan = patch.items && meal.scanId && this.photoSource ? await this.photoSource.itemsFor(meal.userId, meal.scanId) : null;
    const products = patch.items ? await this.productsFor(meal.userId, patch.items) : undefined;
    const items = patch.items ? MealsService.storeItems(patch.items, { scan, prior: meal.items, records: this.records.index, products }) : meal.items;
    const multiplier = patch.portionMultiplier ?? meal.portionMultiplier;
    if (patch.items) set.items = items;
    if (patch.portionMultiplier !== undefined) set.portionMultiplier = multiplier;
    set.totals = computeMealTotals(items, multiplier);
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

  /** Entries saved before these fields existed report them as unknown, not as zero. */
  private static totalsView(t: Partial<MealTotals> & Pick<MealTotals, 'kcal' | 'proteinG' | 'carbsG' | 'fatG'>): MealTotals {
    return { kcal: t.kcal, proteinG: t.proteinG, carbsG: t.carbsG, fatG: t.fatG, fiberG: t.fiberG ?? null, sugarG: t.sugarG ?? null, sodiumMg: t.sodiumMg ?? null, incomplete: t.incomplete ?? [] };
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
          sugarG: i.sugarG ?? null,
          sodiumMg: i.sodiumMg ?? null,
          preparation: i.preparation ?? null,
          scanItemId: i.scanItemId ?? null,
          per100g: i.per100g ?? null,
          source: i.source ?? null,
          otherNutrients: i.otherNutrients ?? [],
          richIn: i.richIn ?? [],
          confidence: i.confidence ?? null,
          scaled: { grams: r1(s.grams), kcal: r0OrNull(s.kcal), proteinG: r1OrNull(s.proteinG), carbsG: r1OrNull(s.carbsG), fatG: r1OrNull(s.fatG) },
        };
      }),
      totals: MealsService.totalsView(d.totals),
      deletedAt: d.deletedAt ? new Date(d.deletedAt).toISOString() : null,
      restorableUntil: d.deletedAt ? new Date(new Date(d.deletedAt).getTime() + RESTORE_MS).toISOString() : null,
      createdAt: new Date(d.createdAt).toISOString(),
      updatedAt: new Date(d.updatedAt).toISOString(),
    };
  }
}
