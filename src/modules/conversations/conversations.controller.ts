import { Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
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
import { ApiErrors, ZBody, ZParam, ZResponse } from '../../common/zod/decorators';
import { RealtimeService } from './services/realtime.service';
import { ConversationsService } from './services/conversations.service';

@ApiTags('conversations')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationsController {
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
