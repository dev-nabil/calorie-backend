import { Schema, Types } from 'mongoose';
import type { AnswerValue } from '../../../shared';

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
  /** Coach (Milo buddy): the cards of an assistant reply, health numbers removed. */
  cards?: unknown[] | null;
  /** Coach: the app's retry key (user message) / the turn this answers (assistant message). */
  clientTurnId?: string | null;
  /** Coach, assistant: the reply as sent (health numbers removed), replayed for a retry with the same clientTurnId. */
  snapshot?: unknown;
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
    cards: { type: Schema.Types.Mixed, default: null },
    clientTurnId: { type: String, default: null },
    snapshot: { type: Schema.Types.Mixed, default: null },
  },
  { collection: 'messages', timestamps: true },
);
MessageSchema.index({ userId: 1, conversationId: 1, createdAt: 1 });
// One user message per retry key: a repeated turn finds the first one instead of answering twice.
MessageSchema.index({ userId: 1, conversationId: 1, role: 1, clientTurnId: 1 }, { unique: true, partialFilterExpression: { clientTurnId: { $type: 'string' } } });

export interface ChatDraftDoc {
  /** The draft id (uuid). */
  _id: string;
  userId: Types.ObjectId;
  conversationId: Types.ObjectId;
  /** The active draft of its conversation; parked ones can be resumed. */
  active: boolean;
  /** Same as data.version: the compare-and-set key. */
  version: number;
  data: unknown;
  updatedAt: Date;
  /** Kept 30 days after the last change (TTL). */
  expiresAt: Date;
}

/** chat_drafts (Milo buddy): the recipe or meal being built in chat, versioned. Purged with the account and exported. */
export const ChatDraftSchema = new Schema<ChatDraftDoc>(
  {
    _id: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    conversationId: { type: Schema.Types.ObjectId, required: true },
    active: { type: Boolean, default: true },
    version: { type: Number, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'chat_drafts', timestamps: true, minimize: false },
);
ChatDraftSchema.index({ userId: 1, conversationId: 1, active: 1, updatedAt: -1 });
ChatDraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export interface ChatActionDoc {
  /** The action id from the card (a_…). */
  _id: string;
  userId: Types.ObjectId;
  conversationId: Types.ObjectId;
  type: string;
  draftId: string | null;
  draftVersion: number | null;
  payload: unknown;
  status: 'open' | 'running' | 'done';
  result: unknown;
  claimedAt: Date | null;
  createdAt: Date;
  /** After this the action answers 410 ACTION_EXPIRED. */
  usableUntil: Date;
  /** Row removed 30 days after creation (TTL). */
  expiresAt: Date;
}

/** chat_actions (Milo buddy): what each card button does, stored server-side; runs once and replays its result. */
export const ChatActionSchema = new Schema<ChatActionDoc>(
  {
    _id: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    conversationId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, required: true },
    draftId: { type: String, default: null },
    draftVersion: { type: Number, default: null },
    payload: { type: Schema.Types.Mixed, default: null },
    status: { type: String, enum: ['open', 'running', 'done'], default: 'open' },
    result: { type: Schema.Types.Mixed, default: null },
    claimedAt: { type: Date, default: null },
    usableUntil: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'chat_actions', timestamps: true, minimize: false },
);
ChatActionSchema.index({ userId: 1, conversationId: 1 });
ChatActionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
