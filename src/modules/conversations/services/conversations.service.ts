import { Injectable } from '@nestjs/common';
import { JobQueue } from '../../../jobs/jobs.module';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { ERROR_CODES, type ChatCard, type Conversation, type LatestConversation, type MiloReply, type TurnRequest } from '../../../shared';
import { containsHealthKeys, stripHealth } from '../../../domain/buddy-cards';
import { ApiError } from '../../../common/errors/api-error';
import { KvStore } from '../../../infra/kv/kv-store';
import { UsersService } from '../../users/users.service';
import { CoachService, quickActionOf, type BuddyState, type CoachTurnResult } from './coach.service';
import type { ConversationDoc, MessageDoc } from '../schemas/conversations.schema';
import { OnboardingTurnsService } from './onboarding-turns.service';
import { SUMMARY_EVERY, SUMMARY_JOB } from './conversation-summaries.service';
import { ActionsService } from './actions.service';
import { DraftsService } from './drafts.service';

/** One coach turn at a time per conversation; a crashed turn frees the lock after this. */
const TURN_LOCK_SEC = 90;

interface RecordOptions {
  quickAction?: string | null;
  extracted?: unknown;
  cards?: ChatCard[] | null;
  clientTurnId?: string | null;
  snapshot?: unknown;
  id?: Types.ObjectId;
}

@Injectable()
export class ConversationsService {
  constructor(
    @InjectModel('Conversation') private readonly conversations: Model<ConversationDoc>,
    @InjectModel('Message') private readonly messages: Model<MessageDoc>,
    private readonly users: UsersService,
    private readonly onboarding: OnboardingTurnsService,
    private readonly coach: CoachService,
    private readonly jobs: JobQueue,
    private readonly kv: KvStore,
    private readonly drafts: DraftsService,
    private readonly actions: ActionsService,
  ) {}

  async create(userId: string, type: 'onboarding' | 'coach'): Promise<Conversation> {
    const user = await this.users.requireActive(userId);
    const doc = (await this.conversations.create({ userId: user._id, type })).toObject() as ConversationDoc;
    const opening = type === 'onboarding' ? await this.onboarding.opening() : await this.coach.opening(user.displayName);
    const msg = await this.record(doc, 'assistant', opening.reply, null);
    return { id: doc._id.toString(), type, status: 'active', createdAt: new Date(doc.createdAt).toISOString(), opening: { ...opening, conversationId: doc._id.toString(), messageId: msg } };
  }

  async find(userId: string, id: string): Promise<ConversationDoc> {
    const doc = await this.conversations.findOne({ _id: id, userId: new Types.ObjectId(userId) }).lean<ConversationDoc>();
    if (!doc) throw ApiError.notFound(ERROR_CODES.CONVERSATION_NOT_FOUND, 'Conversation not found');
    return doc;
  }

  /** The newest coach conversation with its active draft, so the app resumes instead of starting over. */
  async latest(userId: string): Promise<LatestConversation> {
    const user = await this.users.requireActive(userId);
    const doc = await this.conversations.findOne({ userId: user._id, type: 'coach' }).sort({ createdAt: -1 }).lean<ConversationDoc>();
    if (!doc) throw ApiError.notFound(ERROR_CODES.CONVERSATION_NOT_FOUND, 'No coach conversation yet');
    return {
      id: doc._id.toString(),
      type: 'coach',
      status: doc.status,
      createdAt: new Date(doc.createdAt).toISOString(),
      lastMessageAt: doc.lastMessageAt ? new Date(doc.lastMessageAt).toISOString() : null,
      messageCount: doc.messageCount ?? 0,
      draft: await this.drafts.active(user._id, doc._id),
    };
  }

  /** Clears chat history (conversations, messages, drafts, card actions). Memories, notes, recipes and the diary stay. */
  async deleteCoach(userId: string): Promise<void> {
    const user = await this.users.requireActive(userId);
    const ids = (await this.conversations.find({ userId: user._id, type: 'coach' }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>()).map((c) => c._id);
    if (!ids.length) return;
    await this.messages.deleteMany({ userId: user._id, conversationId: { $in: ids } });
    await this.drafts.deleteForConversations(user._id, ids);
    await this.actions.deleteForConversations(user._id, ids);
    await this.conversations.deleteMany({ userId: user._id, _id: { $in: ids } });
  }

  async turn(userId: string, id: string, req: TurnRequest, onDelta?: (t: string) => void, onState?: (s: BuddyState) => void): Promise<MiloReply> {
    const conv = await this.find(userId, id);
    if (conv.type === 'coach' && req.clientTurnId) return this.coachTurnOnce(conv, req, onDelta, onState);
    return this.runTurn(conv, req, onDelta, onState);
  }

  /**
   * A coach turn with a retry key: the stored answer for a key that already finished (no second model call or action);
   * 409 TURN_IN_PROGRESS while it (or another turn of this conversation) runs; a key whose turn crashed runs again.
   */
  private async coachTurnOnce(conv: ConversationDoc, req: TurnRequest, onDelta?: (t: string) => void, onState?: (s: BuddyState) => void): Promise<MiloReply> {
    const key = req.clientTurnId!;
    const answered = () => this.messages.findOne({ conversationId: conv._id, userId: conv.userId, role: 'assistant', clientTurnId: key }).lean<MessageDoc>();
    const done = await answered();
    if (done?.snapshot) return this.replay(done.snapshot as MiloReply, onDelta, onState);
    const lock = `turn:${conv._id.toString()}`;
    if (!(await this.kv.setIfAbsent(lock, key, TURN_LOCK_SEC))) throw ApiError.conflict(ERROR_CODES.TURN_IN_PROGRESS, 'Milo is still answering the last message');
    try {
      // The first request may have stored its answer between the lookup above and taking the lock.
      const late = await answered();
      if (late?.snapshot) return this.replay(late.snapshot as MiloReply, onDelta, onState);
      // A user message with this key but no answer is a turn that crashed: it runs again.
      await this.messages.deleteOne({ conversationId: conv._id, userId: conv.userId, role: 'user', clientTurnId: key });
      return await this.runTurn(conv, req, onDelta, onState);
    } finally {
      await this.kv.del(lock);
    }
  }

  private replay(snapshot: MiloReply, onDelta?: (t: string) => void, onState?: (s: BuddyState) => void): MiloReply {
    if (snapshot.cards?.length || snapshot.draft) {
      onState?.({ clientTurnId: snapshot.clientTurnId ?? null, draft: snapshot.draft ?? null, cards: snapshot.cards ?? [], executed: snapshot.executed ?? [], draftConflict: snapshot.draftConflict ?? false, clarify: snapshot.clarify ?? null });
    }
    onDelta?.(snapshot.reply);
    return snapshot;
  }

  private async runTurn(conv: ConversationDoc, req: TurnRequest, onDelta?: (t: string) => void, onState?: (s: BuddyState) => void): Promise<MiloReply> {
    // A tapped coach chip is stored as the quick action it stands for, so the coach reads its history as "asked for X".
    const asked = conv.type === 'coach' ? quickActionOf(req) : (req.quickAction ?? null);
    const clientTurnId = conv.type === 'coach' ? (req.clientTurnId ?? null) : null;
    try {
      await this.record(conv, 'user', req.text ?? (asked ? `[${asked}]` : `[chip ${req.chipIndex}]`), req.inputMethod, { quickAction: asked, clientTurnId });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw ApiError.conflict(ERROR_CODES.TURN_IN_PROGRESS, 'Milo is still answering the last message');
      throw e;
    }
    if (conv.type === 'onboarding') {
      const reply = await this.onboarding.turn(conv, req);
      const messageId = await this.record(conv, 'assistant', reply.reply, null, { quickAction: reply.quickAction, extracted: reply.extracted.length ? reply.extracted : null });
      return { ...reply, conversationId: conv._id.toString(), messageId };
    }
    const result: CoachTurnResult = await this.coach.turn(conv, req, onDelta, onState);
    const messageId = new Types.ObjectId();
    const reply: MiloReply = { ...result, clientTurnId, conversationId: conv._id.toString(), messageId: messageId.toString() };
    // Health numbers from the phone never reach the database: cards are stored and replayed without them.
    const stored: MiloReply = { ...reply, cards: stripHealth(reply.cards ?? []) };
    if (containsHealthKeys(stored)) throw new Error('health numbers left in a stored coach reply');
    await this.record(conv, 'assistant', reply.reply, null, { quickAction: reply.quickAction, cards: stored.cards, clientTurnId, snapshot: clientTurnId ? stored : null, id: messageId });
    return reply;
  }

  async confirm(userId: string, id: string, accept: boolean): Promise<MiloReply> {
    const conv = await this.find(userId, id);
    if (conv.type !== 'onboarding') throw ApiError.conflict(ERROR_CODES.NOTHING_TO_CONFIRM, 'Only onboarding conversations have confirmations');
    const reply = await this.onboarding.confirm(conv, accept);
    const messageId = await this.record(conv, 'assistant', reply.reply, null);
    return { ...reply, conversationId: id, messageId };
  }

  async list(userId: string, id: string, limit: number) {
    const conv = await this.find(userId, id);
    // The newest `limit` messages, oldest first: a resumed long chat shows its latest turns, not its first ones.
    const docs = (await this.messages.find({ userId: conv.userId, conversationId: conv._id }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean<MessageDoc[]>()).reverse();
    return {
      items: docs.map((m) => ({
        id: m._id.toString(),
        role: m.role,
        text: m.text,
        inputMethod: m.inputMethod,
        createdAt: new Date(m.createdAt).toISOString(),
        ...(m.cards?.length ? { cards: m.cards as ChatCard[] } : {}),
        ...(m.clientTurnId ? { clientTurnId: m.clientTurnId } : {}),
      })),
      nextCursor: null,
    };
  }

  private async record(conv: ConversationDoc, role: 'user' | 'assistant', text: string, inputMethod: string | null, o: RecordOptions = {}): Promise<string> {
    const m = await this.messages.create({
      ...(o.id ? { _id: o.id } : {}),
      conversationId: conv._id,
      userId: conv.userId,
      role,
      text: text || '…',
      inputMethod,
      quickAction: o.quickAction ?? null,
      extracted: o.extracted ?? null,
      cards: o.cards?.length ? o.cards : null,
      clientTurnId: o.clientTurnId ?? null,
      snapshot: o.snapshot ?? null,
    });
    const updated = await this.conversations.findOneAndUpdate({ _id: conv._id }, { $set: { lastMessageAt: new Date() }, $inc: { messageCount: 1 } }, { returnDocument: 'after' }).lean<ConversationDoc>();
    const count = updated?.messageCount ?? 0;
    if (conv.type === 'coach' && count > 0 && count % SUMMARY_EVERY === 0) {
      await this.jobs.enqueue(SUMMARY_JOB, { conversationId: conv._id.toString() }, { key: `summary-${conv._id.toString()}-${count}` });
    }
    return m._id.toString();
  }
}
