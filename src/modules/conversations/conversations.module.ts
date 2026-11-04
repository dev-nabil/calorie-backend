import { Controller, Get, HttpCode, Injectable, Module, OnModuleInit, Post, Query, Res } from '@nestjs/common';
import { JobHandlers, JobQueue } from '../../jobs/background-jobs';
import { AiProvider } from '../ai/ai.provider';
import { AiService } from '../ai/ai.service';
import { InjectModel } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Types, type Model } from 'mongoose';
import {
  ConfirmRequestSchema,
  ConversationSchema,
  CreateConversationRequestSchema,
  ERROR_CODES,
  MessageListSchema,
  MiloReplySchema,
  ObjectIdSchema,
  RealtimeSessionSchema,
  RealtimeToolRequestSchema,
  RealtimeToolResultSchema,
  RealtimeUsageRequestSchema,
  TurnRequestSchema,
  type ConfirmRequest,
  type Conversation,
  type CreateConversationRequest,
  type MiloReply,
  type RealtimeSession,
  type RealtimeToolRequest,
  type RealtimeToolResult,
  type RealtimeUsageRequest,
  type TurnRequest,
} from '../../shared';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { ApiError } from '../../common/errors/api-error';
import { ErrorFilter } from '../../common/errors/error.filter';
import { noStore } from '../../common/http/etag';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { RequireIntegrity } from '../../common/integrity/integrity';
import { ApiErrors, ZBody, ZParam, ZResponse } from '../../common/zod/decorators';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { TrackingModule } from '../tracking/tracking.module';
import { UsersService } from '../users/users.service';
import { CoachService } from './coach.service';
import type { ConversationDoc, MessageDoc } from './conversations.schemas';
import { ExtractionHandler } from './extraction.handler';
import { OnboardingTurnsService } from './onboarding-turns.service';
import { RealtimeService } from './realtime.service';

export const SUMMARY_JOB = 'conversation_summary';
export const SUMMARY_EVERY = 20; // plan 8.6: rolling summary every 20 messages

/** Worker job: folds older messages into conversations.summary (sent with every coach turn). */
@Injectable()
export class ConversationSummaries implements OnModuleInit {
  constructor(
    @InjectModel('Conversation') private readonly conversations: Model<ConversationDoc>,
    @InjectModel('Message') private readonly messages: Model<MessageDoc>,
    private readonly handlers: JobHandlers,
    private readonly ai: AiService,
    private readonly provider: AiProvider,
  ) {}

  onModuleInit(): void {
    this.handlers.register(SUMMARY_JOB, (p) => this.summarise((p as { conversationId: string }).conversationId));
  }

  async summarise(conversationId: string): Promise<string> {
    const conv = await this.conversations.findById(conversationId).lean<ConversationDoc>();
    if (!conv) return '';
    const recent = (await this.messages.find({ conversationId: conv._id }).sort({ createdAt: -1 }).limit(SUMMARY_EVERY * 2).lean<MessageDoc[]>()).reverse();
    const transcript = recent.map((m) => `${m.role === 'user' ? 'User' : 'Milo'}: ${m.text}`).join('\n');
    const model = await this.ai.modelFor('chat', 'gpt-5-mini');
    const res = await this.ai.runOrUnavailable('chat', () =>
      this.provider.complete({
        model,
        instructions: 'Summarise this nutrition-coach conversation in at most 5 short bullet points: goals, preferences, open questions and anything the user asked Milo to remember. No health judgements. Plain UK English.',
        messages: [{ role: 'user', content: `Earlier summary:\n${conv.summary || 'None'}\n\nLatest messages:\n${transcript}` }],
        timeoutMs: 15_000,
        maxOutputTokens: 200,
      }),
    );
    const summary = String(res.output).slice(0, 2000);
    await this.conversations.updateOne({ _id: conv._id }, { $set: { summary } });
    return summary;
  }
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

@ApiTags('conversations')
@ApiBearerAuth()
@Controller('conversations')
class ConversationsController {
  private readonly filter = new ErrorFilter();
  constructor(
    private readonly svc: ConversationsService,
    private readonly realtime: RealtimeService,
  ) {}

  @Post()
  @Idempotent()
  @ZResponse(201, ConversationSchema, 'Starts an onboarding or coach conversation with Milo’s opening line')
  @ApiErrors(400, 401)
  create(@CurrentUser() u: AuthUser, @ZBody(CreateConversationRequestSchema) body: CreateConversationRequest): Promise<Conversation> {
    return this.svc.create(u.id, body.type);
  }

  @Get(':id/messages')
  @ZResponse(200, MessageListSchema)
  @ApiErrors(401, 404)
  async messages(@CurrentUser() u: AuthUser, @ZParam('id', ObjectIdSchema) id: string, @Query('limit') limit: string | undefined, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.svc.list(u.id, id, Math.min(200, Math.max(1, Number(limit) || 100)));
  }

  @Post(':id/turns')
  @HttpCode(200)
  @RequireIntegrity()
  @ApiQuery({ name: 'stream', required: false, description: 'true: coach replies as server-sent events (event delta {text}, then done MiloReply, or error)' })
  @ZResponse(200, MiloReplySchema)
  @ApiErrors(400, 401, 402, 404, 429, 502, 503)
  async turn(
    @CurrentUser() u: AuthUser,
    @ZParam('id', ObjectIdSchema) id: string,
    @ZBody(TurnRequestSchema) body: TurnRequest,
    @Query('stream') stream: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MiloReply | undefined> {
    if (stream !== 'true') return this.svc.turn(u.id, id, body);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const reply = await this.svc.turn(u.id, id, body, (text) => send('delta', { text }));
      send('done', reply);
    } catch (e) {
      send('error', this.filter.render(e).body);
    }
    res.end();
    return undefined;
  }

  /** Realtime voice (OpenAI Realtime over WebRTC): a short-lived secret that lets the app talk to the model directly. */
  @Post(':id/realtime')
  @HttpCode(200)
  @RequireIntegrity()
  @ZResponse(200, RealtimeSessionSchema, 'Ephemeral client secret and call details for the onboarding voice conversation (never cached)')
  @ApiErrors(400, 401, 403, 404, 409, 429, 503)
  async realtimeSession(@CurrentUser() u: AuthUser, @ZParam('id', ObjectIdSchema) id: string, @Res({ passthrough: true }) res: Response): Promise<RealtimeSession> {
    noStore(res);
    return this.realtime.createSession(u.id, id);
  }

  /** A tool call the Realtime model made (record_answers, confirm_answers). The Idempotency-Key is the model's call id. */
  @Post(':id/realtime/tool')
  @HttpCode(200)
  @Idempotent()
  @RequireIntegrity()
  @ZResponse(200, RealtimeToolResultSchema, 'JSON for the model plus the same state as a normal turn')
  @ApiErrors(400, 401, 404, 409, 429, 502, 503)
  realtimeTool(@CurrentUser() u: AuthUser, @ZParam('id', ObjectIdSchema) id: string, @ZBody(RealtimeToolRequestSchema) body: RealtimeToolRequest): Promise<RealtimeToolResult> {
    return this.realtime.tool(u.id, id, body);
  }

  /** Tokens of a finished voice session, read from the model's events by the app; feeds the monthly budget guard. */
  @Post(':id/realtime/usage')
  @HttpCode(204)
  @Idempotent()
  @RequireIntegrity()
  @ZResponse(204, null, 'Recorded')
  @ApiErrors(400, 401, 404)
  async realtimeUsage(@CurrentUser() u: AuthUser, @ZParam('id', ObjectIdSchema) id: string, @ZBody(RealtimeUsageRequestSchema) body: RealtimeUsageRequest): Promise<void> {
    await this.realtime.usage(u.id, id, body);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @ZResponse(200, MiloReplySchema, 'Yes saves the noted answers and moves on; Change discards them')
  @ApiErrors(400, 401, 404, 409)
  confirm(@CurrentUser() u: AuthUser, @ZParam('id', ObjectIdSchema) id: string, @ZBody(ConfirmRequestSchema) body: ConfirmRequest): Promise<MiloReply> {
    return this.svc.confirm(u.id, id, body.accept);
  }
}

@Module({
  imports: [OnboardingModule, TrackingModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, OnboardingTurnsService, RealtimeService, CoachService, ExtractionHandler, ConversationSummaries],
})
export class ConversationsModule {}

/** Worker role: extraction handler for queue `ai`. */
@Module({ providers: [ExtractionHandler, ConversationSummaries] })
export class ConversationsWorkerModule {}
