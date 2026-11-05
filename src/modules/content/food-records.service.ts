import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { buildFoodIndex, type FoodIndex, type FoodRecord } from '../../domain/food-nutrition';
import { FOOD_PREPARATIONS, OTHER_NUTRIENT_KEYS } from '../../shared';
import { defaultContentDir, latestVersionedFile } from './content.loader';

const value = z.number().min(0).nullable();

const FileSchema = z.object({
  version: z.number().int(),
  sources: z.record(z.string(), z.object({ name: z.string().min(1) })),
  records: z.array(
    z.object({
      id: z.string().min(1),
      source: z.string().min(1),
      sourceRef: z.string().min(1),
      sourceName: z.string().min(1),
      kind: z.enum(['single', 'mixed_dish']),
      aliases: z.array(z.string().min(1)).min(1),
      preparations: z.array(z.enum(FOOD_PREPARATIONS)).min(1),
      per100g: z.object({ kcal: value, proteinG: value, carbsG: value, fatG: value, fiberG: value, sugarG: value, sodiumMg: value }),
      other: z.partialRecord(z.enum(OTHER_NUTRIENT_KEYS), z.number().min(0)),
    }),
  ),
});

/** Published nutrition records from content/food-records (provenance in its README). Read once at boot. */
@Injectable()
export class FoodRecordsService {
  readonly index: FoodIndex;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const dir = join(config.CONTENT_DIR ?? defaultContentDir(), 'food-records');
    const file = latestVersionedFile(dir, 'food-records');
    const data = file ? FileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : { sources: {}, records: [] };
    this.index = buildFoodIndex(data.records as FoodRecord[], data.sources);
  }
}
