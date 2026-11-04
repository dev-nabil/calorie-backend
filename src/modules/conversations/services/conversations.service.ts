import { Injectable } from '@nestjs/common';
import { JobQueue } from '../../../jobs/jobs.module';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import {
ERROR_CODES, type Conversation, type MiloReply, type TurnRequest
} from '../../../shared';
import { ApiError } from '../../../common/errors/api-error';
import { UsersService } from '../../users/users.service';
import { CoachService } from './coach.service';
import type { ConversationDoc, MessageDoc } from '../schemas/conversations.schema';
import { OnboardingTurnsService } from './onboarding-turns.service';
import { SUMMARY_EVERY, SUMMARY_JOB } from './conversation-summaries.service';

@Injectable()
export class ConversationsService {
  constructor(
    @InjectModel('Conversation') private readonly conversations: Model<ConversationDoc>,
    @InjectModel('Message') private readonly messages: Model<MessageDoc>,
    private readonly users: UsersService,
    private readonly onboarding: OnboardingTurnsService,
    private readonly coach: CoachService,
    private readonly jobs: JobQueue,
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

  async turn(userId: string, id: string, req: TurnRequest, onDelta?: (t: string) => void): Promise<MiloReply> {
    const conv = await this.find(userId, id);
    await this.record(conv, 'user', req.text ?? (req.quickAction ? `[${req.quickAction}]` : `[chip ${req.chipIndex}]`), req.inputMethod, req.quickAction ?? null);
    const reply = conv.type === 'onboarding' ? await this.onboarding.turn(conv, req) : await this.coach.turn(conv, req, onDelta);
    const messageId = await this.record(conv, 'assistant', reply.reply, null, reply.quickAction, reply.extracted.length ? reply.extracted : null);
    return { ...reply, conversationId: id, messageId };
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
    const docs = await this.messages.find({ userId: conv.userId, conversationId: conv._id }).sort({ createdAt: 1 }).limit(limit).lean<MessageDoc[]>();
    return {
      items: docs.map((m) => ({ id: m._id.toString(), role: m.role, text: m.text, inputMethod: m.inputMethod, createdAt: new Date(m.createdAt).toISOString() })),
      nextCursor: null,
    };
  }

  private async record(conv: ConversationDoc, role: 'user' | 'assistant', text: string, inputMethod: string | null, quickAction: string | null = null, extracted: unknown = null): Promise<string> {
    const m = await this.messages.create({ conversationId: conv._id, userId: conv.userId, role, text: text || '…', inputMethod, quickAction, extracted });
    const updated = await this.conversations.findOneAndUpdate({ _id: conv._id }, { $set: { lastMessageAt: new Date() }, $inc: { messageCount: 1 } }, { returnDocument: 'after' }).lean<ConversationDoc>();
    const count = updated?.messageCount ?? 0;
    if (conv.type === 'coach' && count > 0 && count % SUMMARY_EVERY === 0) {
      await this.jobs.enqueue(SUMMARY_JOB, { conversationId: conv._id.toString() }, { jobId: `summary-${conv._id.toString()}-${count}` });
    }
    return m._id.toString();
  }
}
