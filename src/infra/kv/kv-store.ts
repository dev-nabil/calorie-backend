import { Schema, type Model } from 'mongoose';

/**
 * Small key-value contract (DEC-04): idempotency keys, rate limits, token revocations, admin sessions,
 * short locks and caches. Stored in MongoDB (collection `kv`), so it is shared by every instance and
 * survives restarts and Render spin-downs; no Redis is needed.
 */
export abstract class KvStore {
  abstract get(key: string): Promise<string | null>;
  abstract set(key: string, value: string, ttlSec: number): Promise<void>;
  /** SET NX: true when the key was created (or had expired). */
  abstract setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean>;
  abstract del(key: string): Promise<void>;
  /** Increments a counter; the TTL starts with the first hit. */
  abstract incr(key: string, ttlSec: number): Promise<{ count: number; ttlSec: number }>;
}

export interface KvEntryDoc {
  _id: string;
  /** String values (set). */
  v?: string;
  /** Counters (incr). */
  n?: number;
  expiresAt: Date;
}

/** MongoDB's TTL monitor deletes expired rows about once a minute; reads also check `expiresAt`, so expiry is exact. */
export const KvEntrySchema = new Schema<KvEntryDoc>({ _id: String, v: String, n: Number, expiresAt: { type: Date, required: true } }, { collection: 'kv', versionKey: false });
KvEntrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const isDuplicateKey = (e: unknown): boolean => (e as { code?: number })?.code === 11000;

export class MongoKvStore extends KvStore {
  constructor(
    private readonly model: Model<KvEntryDoc>,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  private expiry(ttlSec: number): Date {
    return new Date(this.now() + ttlSec * 1000);
  }

  async get(key: string): Promise<string | null> {
    const doc = await this.model.findOne({ _id: key, expiresAt: { $gt: new Date(this.now()) } }, { v: 1, n: 1 }).lean<KvEntryDoc>();
    if (!doc) return null;
    return doc.v ?? (doc.n === undefined ? null : String(doc.n));
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    await this.model.replaceOne({ _id: key }, { v: value, expiresAt: this.expiry(ttlSec) }, { upsert: true });
  }

  async setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean> {
    try {
      // Matches only an expired row; a live row makes the upsert insert a duplicate _id, which fails.
      await this.model.replaceOne({ _id: key, expiresAt: { $lte: new Date(this.now()) } }, { v: value, expiresAt: this.expiry(ttlSec) }, { upsert: true });
      return true;
    } catch (e) {
      if (isDuplicateKey(e)) return false;
      throw e;
    }
  }

  async del(key: string): Promise<void> {
    await this.model.deleteOne({ _id: key });
  }

  async incr(key: string, ttlSec: number): Promise<{ count: number; ttlSec: number }> {
    const now = new Date(this.now());
    const live = { $gt: ['$expiresAt', now] };
    // One atomic pipeline update: a live counter goes up by one, a missing or expired one restarts at 1.
    const doc = await this.model
      .findOneAndUpdate(
        { _id: key },
        [
          {
            $set: {
              n: { $cond: [live, { $add: [{ $ifNull: ['$n', 0] }, 1] }, 1] },
              expiresAt: { $cond: [live, '$expiresAt', this.expiry(ttlSec)] },
            },
          },
          { $unset: 'v' },
        ],
        { upsert: true, returnDocument: 'after', updatePipeline: true },
      )
      .lean<KvEntryDoc>();
    const count = doc?.n ?? 1;
    const left = doc ? Math.ceil((new Date(doc.expiresAt).getTime() - now.getTime()) / 1000) : ttlSec;
    return { count, ttlSec: Math.max(1, left) };
  }
}
