import { Schema, Types } from 'mongoose';
import { COACH_TONES, type CoachTone, type MemoryCategory, type ReplyLength } from '../../../shared';

/** One thing Milo learned in chat (Milo buddy, decision 0016), with where it came from and when it last changed. */
export interface CoachMemoryEntry {
  id: string;
  text: string;
  category: MemoryCategory;
  sensitive: boolean;
  /** chat: saved from a conversation with the person's consent; you: written or edited by the person. */
  source: 'chat' | 'you';
  conversationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CoachPreferenceDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tone: CoachTone;
  /** The person's own words, cleaned (domain/coach-style `sanitiseCoachNotes`). */
  notes: string[];
  /** Learned in chat (newest last). Deleting one also resets derived context (`contextResetAt`). */
  memories: CoachMemoryEntry[];
  /** false: chat memories are not used and no new ones are proposed (profile and diary still are). */
  chatMemory: boolean;
  replyLength: ReplyLength;
  /** Messages and summaries from before this instant are no longer sent to the model (memory deleted or cleared). */
  contextResetAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** coach_preferences: Milo's tone, the notes a Plus user asked Milo to remember and the memories learned in chat; one per user. Purged with the account and exported. */
export const CoachPreferenceSchema = new Schema<CoachPreferenceDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    tone: { type: String, enum: COACH_TONES, default: 'warm' },
    notes: { type: [String], default: [] },
    memories: { type: Schema.Types.Mixed, default: [] },
    chatMemory: { type: Boolean, default: true },
    replyLength: { type: String, enum: ['short', 'normal', 'detailed'], default: 'normal' },
    contextResetAt: { type: Date, default: null },
  },
  { collection: 'coach_preferences', timestamps: true, minimize: false },
);
CoachPreferenceSchema.index({ userId: 1 }, { unique: true });
