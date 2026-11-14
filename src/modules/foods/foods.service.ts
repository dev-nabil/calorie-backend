import { HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { clock } from '../../common/clock';
import { ApiError } from '../../common/errors/api-error';
import { requestLocale } from '../../common/http/request-context';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.service';
import { emptyNutrients } from '../../domain/food-nutrition';
import { parseLabelOutput } from '../../domain/nutrition-validator';
import { ERROR_CODES, type BarcodeProduct, type NutrientValues, type NutritionSource } from '../../shared';
import type { ScanDoc } from '../scans/schemas/scans.schema';
import { MealsService, type ProductBasis } from '../tracking/services/meals.service';
import { ProductDatabase, type ProductRecord } from './providers/product-database.provider';
import type { ProductDoc } from './schemas/products.schema';

const FOUND_TTL_MS = 30 * 86_400_000;
const NOT_FOUND_TTL_MS = 86_400_000;
const LOOKUPS_PER_MINUTE = 30;

const isComplete = (v: NutrientValues): boolean => v.kcal !== null && v.proteinG !== null && v.carbsG !== null && v.fatG !== null;

/**
 * Barcode lookups (GET /foods/barcode/{code}). Order: the user's own label scan of that pack, then the
 * product cache, then Open Food Facts. Nothing here calls a model, so a lookup is free.
 */
@Injectable()
export class FoodsService implements OnModuleInit {
  private readonly logger = new Logger('Foods');

  constructor(
    @InjectModel('Product') private readonly products: Model<ProductDoc>,
    @InjectModel('Scan') private readonly scans: Model<ScanDoc>,
    @Inject(ProductDatabase) private readonly db: ProductDatabase,
    private readonly limiter: RateLimiter,
    private readonly meals: MealsService,
  ) {}

  onModuleInit(): void {
    this.meals.setProductSource({ basisFor: (userId, barcode) => this.basisFor(userId, barcode) });
  }

  private dbSource(barcode: string): NutritionSource {
    return { type: 'product_database', recordId: null, name: this.db.name, reference: barcode };
  }

  async lookup(userId: string, barcode: string, now = clock.now()): Promise<BarcodeProduct> {
    await this.limiter.consume({ key: `foods:barcode:${userId}`, limit: LOOKUPS_PER_MINUTE, windowSec: 60 });
    const own = await this.ownLabel(new Types.ObjectId(userId), barcode);
    if (own) return own;
    const cached = await this.products.findById(barcode).lean<ProductDoc>();
    if (cached && cached.expiresAt > now) return this.fromCache(cached);
    const res = await this.db.lookup(barcode, requestLocale());
    if ('unavailable' in res) {
      if (cached) return this.fromCache(cached); // stale beats nothing
      this.logger.warn({ barcode }, 'product database unavailable');
      throw new ApiError(ERROR_CODES.SERVICE_UNAVAILABLE, 'The product database could not be reached', HttpStatus.SERVICE_UNAVAILABLE, { retryAfterSec: 30 });
    }
    const doc = this.toDoc(barcode, res.found ? res.product : null, now);
    await this.products.replaceOne({ _id: barcode }, doc, { upsert: true });
    return this.fromCache(doc);
  }

  /** Trusted basis for saving a meal item: never reaches the outside database. */
  async basisFor(userId: Types.ObjectId, barcode: string): Promise<ProductBasis | null> {
    const own = await this.ownLabel(userId, barcode);
    if (own?.source) return { per100g: own.per100g, source: own.source, richIn: own.richIn, processing: own.processing };
    const cached = await this.products.findById(barcode).lean<ProductDoc>();
    if (!cached?.found || !cached.per100g) return null;
    return { per100g: cached.per100g, source: this.dbSource(barcode), richIn: [], processing: cached.processing ?? null };
  }

  /** The newest succeeded label scan of this pack by this user. */
  private async ownLabel(userId: Types.ObjectId, barcode: string): Promise<BarcodeProduct | null> {
    const scan = await this.scans
      .findOne({ userId, barcode, mode: 'label', status: 'succeeded' }, { result: 1, rawOutput: 1 })
      .sort({ finishedAt: -1 })
      .lean<Pick<ScanDoc, 'result' | 'rawOutput'>>();
    const item = scan?.result?.items[0];
    if (!item) return null;
    // The item holds the default portion; the label's own serving and pack size are in the model output.
    const printed = parseLabelOutput(scan.rawOutput);
    const size = (v: number | null | undefined) => (typeof v === 'number' && v > 0 && v <= 5000 ? v : null);
    return {
      barcode,
      found: true,
      complete: isComplete(item.per100g),
      name: item.name,
      brand: null,
      servingG: printed.ok ? size(printed.value.servingG) : item.grams,
      servingText: item.portion,
      packG: printed.ok ? size(printed.value.packG) : null,
      per100g: item.per100g,
      richIn: item.richIn ?? [],
      processing: item.processing ?? null,
      source: { type: 'package_label', recordId: null, name: null, reference: barcode },
    };
  }

  private toDoc(barcode: string, p: ProductRecord | null, now: Date): ProductDoc {
    return {
      _id: barcode,
      found: p !== null,
      name: p?.name ?? null,
      brand: p?.brand ?? null,
      servingG: p?.servingG ?? null,
      servingText: p?.servingText ?? null,
      packG: p?.packG ?? null,
      per100g: p?.per100g ?? null,
      processing: p?.processing ?? null,
      source: this.db.name,
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + (p ? FOUND_TTL_MS : NOT_FOUND_TTL_MS)),
    };
  }

  private fromCache(d: ProductDoc): BarcodeProduct {
    const per100g = d.per100g ?? emptyNutrients();
    return {
      barcode: d._id,
      found: d.found,
      complete: d.found && isComplete(per100g),
      name: d.name,
      brand: d.brand,
      servingG: d.servingG,
      servingText: d.servingText,
      packG: d.packG,
      per100g,
      richIn: [],
      processing: d.processing ?? null,
      source: d.found ? this.dbSource(d._id) : null,
    };
  }
}
