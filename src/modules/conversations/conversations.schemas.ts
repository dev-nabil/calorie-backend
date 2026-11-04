import { Schema, Types } from 'mongoose';
import type { AnswerValue } from '../../shared';

export interface PendingAnswer {
  questionId: string;
  value: AnswerValue;
  confidence: number;
  held: boolean;
}

export interface ConversationDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: 'onboarding' | 'coach';
  status: 'active' | 'completed';
  started: boolean;
  turnId: string | null;
  held: Record<string, AnswerValue>;
  pending: { answers: PendingAnswer[]; declined: string[]; turnId: string | null; inputMethod?: 'typed' | 'voice' | 'chip' } | null;
  lastChips: { label: string; action?: string; sets?: Record<string, AnswerValue>; skips?: string[] }[];
  summary: string;
  lastMessageAt: Date | null;
  messageCount: number;
  createdAt: Date;
}

export const ConversationSchema = new Schema<ConversationDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, enum: ['onboarding', 'coach'], required: true },
    status: { type: String, enum: ['active', 'completed'], default: 'active' },
    started: { type: Boolean, default: false },
    turnId: { type: String, default: null },
    held: { type: Schema.Types.Mixed, default: {} },
    pending: { type: Schema.Types.Mixed, default: null },
    lastChips: { type: Schema.Types.Mixed, default: [] },
    summary: { type: String, default: '' },
    lastMessageAt: { type: Date, default: null },
    messageCount: { type: Number, default: 0 },
  },
  { collection: 'conversations', timestamps: true, minimize: false },
);
ConversationSchema.index({ userId: 1, type: 1, createdAt: -1 });

export interface MessageDoc {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  userId: Types.ObjectId;
  role: 'user' | 'assistant';
  text: string;
  inputMethod: string | null;
  extracted: unknown;
  quickAction: string | null;
  usage: unknown;
  createdAt: Date;
}

/** messages: retention per BR-14 (coach 12 months, onboarding 90 days after completion). */
export const MessageSchema = new Schema<MessageDoc>(
  {
    conversationId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    text: { type: String, required: true },
    inputMethod: { type: String, default: null },
    extracted: { type: Schema.Types.Mixed, default: null },
    quickAction: { type: String, default: null },
    usage: { type: Schema.Types.Mixed, default: null },
  },
  { collection: 'messages', timestamps: true },
);
MessageSchema.index({ userId: 1, conversationId: 1, createdAt: 1 });
