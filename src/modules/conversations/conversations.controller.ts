import { Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
AI_LIMITS,
ActionRequestSchema,
ActionResultSchema,
DeleteConversationsQuerySchema,
DraftLifecycleRequestSchema,
DraftStateSchema,
ERROR_CODES,
LatestConversationQuerySchema,
LatestConversationSchema,
MealTranscribeResponseSchema,
PatchDraftRequestSchema,
PatchDraftResponseSchema,
TRANSCRIBE_AUDIO_TYPES,
TRANSCRIBE_MAX_BYTES,
type ActionRequest,
type ActionResult,
type ChatCard,
type ChatDraft,
type DraftLifecycleRequest,
type DraftState,
type LatestConversation,
type MealTranscribeResponse,
type PatchDraftRequest,
ConfirmRequestSchema,
ConversationSchema,
CreateConversationRequestSchema, MessageListSchema,
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
type TurnRequest
} from '../../shared';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { ErrorFilter } from '../../common/errors/error.filter';
import { noStore } from '../../common/http/etag';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { RequireIntegrity } from '../../common/integrity/integrity';
import { ApiErrors, ZBody, ZParam, ZQuery, ZResponse } from '../../common/zod/decorators';
import { RealtimeService } from './services/realtime.service';
import { ConversationsService } from './services/conversations.service';
import { ActionsService } from './services/actions.service';
import { DraftsService } from './services/drafts.service';
import { clock } from '../../common/clock';
import { ApiError } from '../../common/errors/api-error';
import { integrityOk } from '../../common/integrity/integrity';
import { DailyQuota } from '../../common/rate-limit/daily-quota';
import { isPlusActive, isVerifiedAccount } from '../../domain/entitlements';
import { draftCards, defaultCategory } from '../../domain/buddy-cards';
import { dayKeyFor } from '../../domain/day-keys';
import { localMinutes } from '../../domain/nudges';
import { AiJobs } from '../ai/ai-jobs';
import { AppConfigService } from '../content/app-config.service';
import { MEAL_TRANSCRIBE_JOB, type TranscribeJob } from '../meal-parse/meal-transcribe.handler';
import { UsersService } from '../users/users.service';

const ActionIdSchema = z.string().regex(/^a_[a-f0-9]{24}$/, 'Expected an action id');
/** The chat composer takes 1000 characters. */
const CHAT_TRANSCRIPT_MAX = 1000;

@ApiTags('conversations')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationsController {
  private readonly filter = new ErrorFilter();
  constructor(
    private readonly svc: ConversationsService,
    private readonly realtime: RealtimeService,
    private readonly drafts: DraftsService,
    private readonly actions: ActionsService,
    private readonly users: UsersService,
    private readonly quota: DailyQuota,
    private readonly appConfig: AppConfigService,
    private readonly runner: AiJobs,
  ) {}

  @Get('latest')
  @ZResponse(200, LatestConversationSchema, 'The newest coach conversation with its active draft (resume it instead of starting over). 404 when there is none')
  @ApiErrors(400, 401, 404)
  async latest(@CurrentUser() u: AuthUser, @ZQuery(LatestConversationQuerySchema) _q: unknown, @Res({ passthrough: true }) res: Response): Promise<LatestConversation> {
    noStore(res);
    return this.svc.latest(u.id);
  }

  @Delete()
  @HttpCode(204)
  @ZResponse(204, null, 'Deletes the coach chat history (conversations, messages, drafts). Memories, notes, recipes and the diary stay')
  @ApiErrors(400, 401)
  async deleteAll(@CurrentUser() u: AuthUser, @ZQuery(DeleteConversationsQuerySchema) _q: unknown): Promise<void> {
    await this.svc.deleteCoach(u.id);
  }

  /** Voice input for Milo chat: the words go into the composer; nothing is analysed or stored (the audio is never kept). */
  @Post('transcribe')
  @HttpCode(200)
  @RequireIntegrity()
  @ApiConsumes(...TRANSCRIBE_AUDIO_TYPES)
  @ApiBody({ description: 'The recording itself (for example 16 kHz mono WAV or AAC); at most 2 MB', schema: { type: 'string', format: 'binary' } })
  @ZResponse(200, MealTranscribeResponseSchema, 'The spoken words as editable text (at most 1000 characters); shares the daily voice allowance with food logging')
  @ApiErrors(400, 401, 402, 403, 413, 429, 502, 503)
  async transcribe(@CurrentUser() u: AuthUser, @Req() req: Request): Promise<MealTranscribeResponse> {
    const type = (req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!(TRANSCRIBE_AUDIO_TYPES as readonly string[]).includes(type)) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `Send the recording as one of ${TRANSCRIBE_AUDIO_TYPES.join(', ')}`, HttpStatus.BAD_REQUEST, { field: 'content-type' });
    }
    const audio = Buffer.isBuffer(req.body) ? req.body : null;
    if (!audio || audio.length < 1024 || audio.length > TRANSCRIBE_MAX_BYTES) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'The recording is empty or too large', HttpStatus.BAD_REQUEST, { field: 'body' });
    }
    const user = await this.users.requireActive(u.id);
    if (!isVerifiedAccount(user)) throw ApiError.forbidden(ERROR_CODES.EMAIL_NOT_VERIFIED, 'Verify your email to talk to Milo by voice');
    if (!integrityOk(req)) throw ApiError.forbidden(ERROR_CODES.INTEGRITY_REQUIRED, 'This device could not be verified');
    const plus = isPlusActive(user.entitlement, clock.now());
    const limits = await this.appConfig.get('limits', AI_LIMITS);
    const plan = (plus ? limits.plus : limits.free) as { coachPerDay: number; transcribePerDay?: number };
    await this.quota.assertAvailable('coach', u.id, user.timezone, plan.coachPerDay, plus, 'You have reached today’s coach messages.');
    await this.quota.assertAvailable('transcribe', u.id, user.timezone, plan.transcribePerDay ?? (plus ? 100 : 20), plus, 'Voice input is used up for today. You can still type.');
    const job: TranscribeJob = { audio, mimeType: type === 'audio/x-wav' ? 'audio/wav' : type, promptKey: 'chat-transcribe', maxText: CHAT_TRANSCRIPT_MAX };
    const result = await this.runner.run<MealTranscribeResponse>(MEAL_TRANSCRIBE_JOB, job);
    await this.quota.consume('transcribe', u.id, user.timezone);
    return result;
  }

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
  @ApiQuery({ name: 'stream', required: false, description: 'true: coach replies as server-sent events: state {clientTurnId, draft, cards, executed, draftConflict, clarify} (once, before the words, when there are cards), delta {text}, then done MiloReply, or error' })
  @ZResponse(200, MiloReplySchema)
  @ApiErrors(400, 401, 402, 404, 409, 429, 502, 503)
  async turn(
    @CurrentUser() u: AuthUser,
    @ZParam('id', ObjectIdSchema) id: string,
    @ZBody(TurnRequestSchema) body: TurnRequest,
    @Query('stream') stream: string | undefined,
    @Req() req: Request,
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
      const reply = await this.svc.turn(
        u.id,
        id,
        body,
        (text) => send('delta', { text }),
        (state) => send('state', state),
      );
      send('done', reply);
    } catch (e) {
      // Same body as a plain error response: localised for the request language, server errors logged.
      send('error', this.filter.forRequest(e, req).body);
    }
    res.end();
    return undefined;
  }

  @Get(':id/draft')
  @ZResponse(200, DraftStateSchema, 'The active draft and up to three parked ones')
  @ApiErrors(401, 404)
  async draft(@CurrentUser() u: AuthUser, @ZParam('id', ObjectIdSchema) id: string, @Res({ passthrough: true }) res: Response): Promise<DraftState> {
    noStore(res);
    const conv = await this.svc.find(u.id, id);
    return this.drafts.state(conv.userId, conv._id);
  }

  @Patch(':id/draft')
  @ZResponse(200, PatchDraftResponseSchema, 'Card edits (no AI call). 409 VERSION_CONFLICT with details.draft when the card is stale')
  @ApiErrors(400, 401, 404, 409, 422)
  async patchDraft(@CurrentUser() u: AuthUser, @ZParam('id', ObjectIdSchema) id: string, @ZBody(PatchDraftRequestSchema) body: PatchDraftRequest): Promise<{ draft: ChatDraft; cards: ChatCard[] }> {
    const conv = await this.svc.find(u.id, id);
    const draft = await this.drafts.patch(conv.userId, conv._id, body);
    return { draft, cards: await this.cardsFor(conv.userId, conv._id, draft, u.id) };
  }

  @Post(':id/draft')
  @HttpCode(200)
  @ZResponse(200, DraftStateSchema, 'new: parks the active draft; resume: makes a parked one active; discard: drops the active one')
  @ApiErrors(400, 401, 404, 409)
  async draftLifecycle(@CurrentUser() u: AuthUser, @ZParam('id', ObjectIdSchema) id: string, @ZBody(DraftLifecycleRequestSchema) body: DraftLifecycleRequest): Promise<DraftState> {
    const conv = await this.svc.find(u.id, id);
    return this.drafts.lifecycle(conv.userId, conv._id, body);
  }

  /** A card button (log, save recipe, apply changes, save memory, create reminder, discard). Runs once; repeats replay the result. */
  @Post(':id/actions/:actionId')
  @HttpCode(200)
  @Idempotent()
  @ZResponse(200, ActionResultSchema, 'Returned only after the write is committed. 409 VERSION_CONFLICT (details.draft) for a stale card, 404 ACTION_NOT_FOUND, 410 ACTION_EXPIRED, 422 ACTION_BLOCKED (details.blockedBy)')
  @ApiErrors(400, 401, 402, 404, 409, 410, 422)
  async action(
    @CurrentUser() u: AuthUser,
    @ZParam('id', ObjectIdSchema) id: string,
    @ZParam('actionId', ActionIdSchema) actionId: string,
    @ZBody(ActionRequestSchema) body: ActionRequest,
  ): Promise<ActionResult> {
    const conv = await this.svc.find(u.id, id);
    return this.actions.execute(u.id, conv._id.toString(), actionId, body, { source: 'text', consented: true });
  }

  /** Fresh cards (with action ids) for a draft after a card edit. */
  private async cardsFor(userId: Types.ObjectId, conversationId: Types.ObjectId, draft: ChatDraft, uid: string): Promise<ChatCard[]> {
    const user = await this.users.requireActive(uid);
    const now = clock.now();
    const built = draftCards(draft, {
      conversationId: conversationId.toString(),
      date: dayKeyFor(now, user.timezone),
      category: draft.category ?? defaultCategory(Math.floor(localMinutes(now, user.timezone) / 60)),
      deletedLogMealIds: await this.actions.deletedLogMeals(userId, draft),
    });
    await this.actions.register(userId, conversationId, built.actions);
    return built.cards;
  }

  /** Realtime voice (Gemini Live over a WebSocket): a short-lived token that lets the app talk to the model directly. */
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
