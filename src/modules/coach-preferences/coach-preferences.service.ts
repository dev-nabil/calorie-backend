import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import type { CoachPreferences, PutCoachPreferencesRequest } from '../../shared';
import { DEFAULT_COACH_STYLE, sanitiseCoachNotes, type CoachStyle } from '../../domain/coach-style';
import type { CoachPreferenceDoc } from './schemas/coach-preferences.schema';

/** Milo's tone and memory per user (Plus). Free users read their stored values; only the coach decides whether they apply. */
@Injectable()
export class CoachPreferencesService {
  constructor(@InjectModel('CoachPreference') private readonly prefs: Model<CoachPreferenceDoc>) {}

  /** Stored preferences, or the defaults (warm, no notes). */
  async get(userId: string): Promise<CoachPreferences> {
    const doc = await this.prefs.findOne({ userId: new Types.ObjectId(userId) }).lean<CoachPreferenceDoc>();
    return doc ? { tone: doc.tone, notes: sanitiseCoachNotes(doc.notes ?? []) } : { tone: DEFAULT_COACH_STYLE.tone, notes: [] };
  }

  /** Full replace; the same body twice leaves the same row. */
  async put(userId: string, body: PutCoachPreferencesRequest): Promise<CoachPreferences> {
    const notes = sanitiseCoachNotes(body.notes);
    const uid = new Types.ObjectId(userId);
    await this.prefs.updateOne({ userId: uid }, { $set: { tone: body.tone, notes }, $setOnInsert: { userId: uid } }, { upsert: true });
    return { tone: body.tone, notes };
  }

  /** What the coach applies for a Plus user; null for the default style, so nothing is added to the prompt. */
  async styleFor(userId: string): Promise<CoachStyle | null> {
    const p = await this.get(userId);
    return p.tone === 'warm' && p.notes.length === 0 ? null : p;
  }
}
