import { sanitisePer100g } from '../../../domain/food-nutrition';
import { KJ_PER_KCAL, SODIUM_MG_PER_G_SALT } from '../../../domain/nutrition-validator';
import type { FoodProcessing, NutrientValues } from '../../../shared';

/** A product as a database knows it. Values per 100 g (or 100 ml); null when unknown. */
export interface ProductRecord {
  barcode: string;
  name: string | null;
  brand: string | null;
  servingG: number | null;
  servingText: string | null;
  packG: number | null;
  per100g: NutrientValues;
  /** From the NOVA group; null or absent when the database does not know it. */
  processing?: FoodProcessing | null;
}

/** `unavailable`: the database could not be asked (network, timeout, 5xx). Not the same as an unknown barcode. */
export type ProductLookup = { found: true; product: ProductRecord } | { found: false } | { unavailable: true };

export abstract class ProductDatabase {
  abstract readonly name: string;
  abstract lookup(barcode: string, lang: string): Promise<ProductLookup>;
}

/**
 * Open Food Facts drops the serving and pack fields from a reply that also asks for `nutriments`
 * (seen 9 Nov 2026, API v2 and v3), so the two halves are fetched side by side.
 */
const PRODUCT_FIELDS = ['code', 'product_name', 'product_name_en', 'product_name_bn', 'generic_name', 'brands', 'serving_size', 'serving_quantity', 'serving_quantity_unit', 'product_quantity', 'product_quantity_unit', 'nova_group'];
const NUTRIENT_FIELDS = ['nutriments'];

type Json = Record<string, unknown>;
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
};
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
/** Weights in g or ml only: other units (oz, pieces) are not trusted as grams. */
const grams = (qty: unknown, unit: unknown): number | null => {
  const q = num(qty);
  const u = typeof unit === 'string' ? unit.toLowerCase() : 'g';
  if (q === null || q <= 0) return null;
  if (u === 'g' || u === 'ml') return q;
  if (u === 'kg' || u === 'l') return q * 1000;
  if (u === 'cl') return q * 10;
  return null;
};

/** NOVA group (1 unprocessed or minimally processed … 4 ultra-processed) → how processed the food is. */
export function processingFromNova(v: unknown): FoodProcessing | null {
  const g = num(v);
  if (g === 1) return 'whole';
  if (g === 2 || g === 3) return 'processed';
  if (g === 4) return 'ultra_processed';
  return null;
}

/** Open Food Facts product JSON → record. Energy falls back to kJ and sodium to salt, as on the label. */
export function productFromOpenFoodFacts(barcode: string, p: Json, lang: string): ProductRecord {
  const n = (p.nutriments ?? {}) as Json;
  // energy_100g is always kJ in Open Food Facts' normalised data.
  const kj = num(n['energy-kj_100g']) ?? num(n.energy_100g);
  const kcal = num(n['energy-kcal_100g']) ?? (kj === null ? null : kj / KJ_PER_KCAL);
  const sodiumG = num(n.sodium_100g);
  const salt = num(n.salt_100g);
  const raw: NutrientValues = {
    kcal,
    proteinG: num(n.proteins_100g),
    carbsG: num(n.carbohydrates_100g),
    fatG: num(n.fat_100g),
    fiberG: num(n.fiber_100g),
    sugarG: num(n.sugars_100g),
    sodiumMg: sodiumG !== null ? sodiumG * 1000 : salt !== null ? salt * SODIUM_MG_PER_G_SALT : null,
  };
  const brand = text(p.brands, 80)?.split(',')[0]?.trim() ?? null;
  return {
    barcode,
    name: text(p[`product_name_${lang}`], 120) ?? text(p.product_name, 120) ?? text(p.product_name_en, 120) ?? text(p.generic_name, 120),
    brand,
    servingG: grams(p.serving_quantity, p.serving_quantity_unit ?? 'g'),
    servingText: text(p.serving_size, 60),
    packG: grams(p.product_quantity, p.product_quantity_unit ?? 'g'),
    per100g: sanitisePer100g(raw).per100g,
    processing: processingFromNova(p.nova_group),
  };
}

export interface OpenFoodFactsOptions {
  enabled: boolean;
  baseUrl: string;
  userAgent: string;
  timeoutMs: number;
}

/**
 * Open Food Facts API v2. Read-only and keyless; it asks for a User-Agent naming the app. The options are
 * the admin settings foods.barcode.*, read per lookup; switched off, every lookup is unavailable, so the
 * app offers a label scan.
 */
export class OpenFoodFactsDatabase extends ProductDatabase {
  readonly name = 'Open Food Facts';

  constructor(private readonly options: () => Promise<OpenFoodFactsOptions>) {
    super();
  }

  async lookup(barcode: string, lang: string): Promise<ProductLookup> {
    const o = await this.options();
    if (!o.enabled) return { unavailable: true };
    const [meta, nutrients] = await Promise.all([this.fetchFields(o, barcode, PRODUCT_FIELDS), this.fetchFields(o, barcode, NUTRIENT_FIELDS)]);
    if (meta === 'unavailable') return { unavailable: true };
    if (meta === 'not_found') return { found: false };
    // Never cache a product without its nutrition because one half failed.
    if (nutrients === 'unavailable') return { unavailable: true };
    const product = { ...meta, nutriments: nutrients === 'not_found' ? {} : (nutrients.nutriments ?? {}) };
    return { found: true, product: productFromOpenFoodFacts(barcode, product, lang) };
  }

  private async fetchFields(o: OpenFoodFactsOptions, barcode: string, fields: string[]): Promise<Json | 'not_found' | 'unavailable'> {
    const url = `${o.baseUrl.replace(/\/$/, '')}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields.join(',')}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': o.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(o.timeoutMs) });
    } catch {
      return 'unavailable';
    }
    if (res.status >= 500 || res.status === 429) return 'unavailable';
    const body = (await res.json().catch(() => null)) as { status?: number; product?: Json } | null;
    if (!body) return res.ok ? 'unavailable' : 'not_found';
    if (body.status !== 1 || !body.product) return 'not_found';
    return body.product;
  }
}

/** Tests and offline dev: a fixed catalogue. */
export class FakeProductDatabase extends ProductDatabase {
  readonly name = 'Open Food Facts';
  readonly calls: string[] = [];
  unavailable = false;
  readonly products = new Map<string, ProductRecord>();

  reset(): void {
    this.calls.length = 0;
    this.unavailable = false;
    this.products.clear();
  }

  lookup(barcode: string): Promise<ProductLookup> {
    this.calls.push(barcode);
    if (this.unavailable) return Promise.resolve({ unavailable: true });
    const product = this.products.get(barcode);
    return Promise.resolve(product ? { found: true, product } : { found: false });
  }
}
