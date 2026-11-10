import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { AppConfigDoc } from './schemas/content.schema';

const CACHE_MS = 30_000;

/** Runtime flags, limits and kill switches from app_config (plan 8.9, 8.10). */
@Injectable()
export class AppConfigService {
  private readonly cache = new Map<string, { value: unknown; at: number }>();

  constructor(@InjectModel('AppConfig') private readonly model: Model<AppConfigDoc>) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return (hit.value ?? fallback) as T;
    const doc = await this.model.findOne({ key }).lean();
    const value = doc ? doc.value : undefined;
    this.cache.set(key, { value, at: Date.now() });
    return (value ?? fallback) as T;
  }

  async set(key: string, value: unknown, updatedBy = 'system', description?: string, reason?: string): Promise<void> {
    await this.model.updateOne(
      { key },
      { $set: { value, updatedBy, ...(description ? { description } : {}), ...(reason !== undefined ? { reason } : {}) } },
      { upsert: true },
    );
    this.cache.delete(key);
  }

  /** Back to the code default. */
  async unset(key: string): Promise<void> {
    await this.model.deleteOne({ key });
    this.cache.delete(key);
  }

  /** Value plus who changed it and when (admin panel). */
  async getDoc(key: string): Promise<{ value: unknown; updatedAt: Date | null; updatedBy: string; reason: string | null } | null> {
    const doc = await this.model.findOne({ key }).lean<{ value: unknown; updatedAt?: Date; updatedBy?: string; reason?: string | null }>();
    return doc ? { value: doc.value, updatedAt: doc.updatedAt ?? null, updatedBy: doc.updatedBy ?? 'system', reason: doc.reason ?? null } : null;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
