import { Schema, Types } from 'mongoose';
import { COACH_TONES, type CoachTone } from '../../../shared';

export interface CoachPreferenceDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tone: CoachTone;
  /** The person's own words, cleaned (domain/coach-style `sanitiseCoachNotes`). */
  notes: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** coach_preferences: Milo's tone and the notes a Plus user asked Milo to remember; one per user. Purged with the account and exported. */
export const CoachPreferenceSchema = new Schema<CoachPreferenceDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    tone: { type: String, enum: COACH_TONES, default: 'warm' },
    notes: { type: [String], default: [] },
  },
  { collection: 'coach_preferences', timestamps: true, minimize: false },
);
CoachPreferenceSchema.index({ userId: 1 }, { unique: true });
