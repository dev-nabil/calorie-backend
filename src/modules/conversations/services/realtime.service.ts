import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { z } from 'zod';
import { APP_CONFIG } from '../../../config/config.module';
import type { AppConfig } from '../../../config/env';
import { ERROR_CODES, type MiloReply, type RealtimeSession, type RealtimeToolRequest, type RealtimeToolResult, type RealtimeUsageRequest } from '../../../shared';
import { localeInfo } from '../../../shared/locales';
import { requestLocale } from '../../../common/http/request-context';
import { DailyQuota } from '../../../common/rate-limit/daily-quota';
import { ApiError } from '../../../common/errors/api-error';
import { DEFAULT_REALTIME_MODEL } from '../../ai/ai-models';
import { AiProvider, type RealtimeToolDeclaration } from '../../ai/ai.provider';
import { DEFAULT_VOICE, voiceOrDefault } from '../../ai/providers/gemini.provider';
import { AiService, AiUnavailableError } from '../../ai/ai.service';
import { CONFIG_DEFAULTS } from '../../app-config/app-config.defaults';
import { AppConfigService } from '../../content/app-config.service';
import { fillTemplate } from '../../content/content.loader';
import { ContentService } from '../../content/content.service';
import { UsersService } from '../../users/users.service';
import { schemaFromPrompt } from '../extraction.handler';
import type { ConversationDoc } from '../schemas/conversations.schema';
import { OnboardingTurnsService } from './onboarding-turns.service';

/** The app must open the call within this long after the token is minted. */
const SECRET_TTL_SEC = 120;
/** The app ends a session after this long (onboarding takes about three minutes). */
export const REALTIME_MAX_SECONDS = 600;
/** A hard stop per response, about 25 seconds of speech. Length is set by the prompt; a large `record_answers` call must still fit. */
export const REALTIME_MAX_OUTPUT_TOKENS = 500;
/** Silence that ends the user's turn (owner decision, ADR 0008). */
export const REALTIME_SILENCE_MS = 3000;
/** The token outlives the app's own timer by this much, so Google never closes a call the app still counts as open. */
const SESSION_GRACE_SEC = 60;
const SECRET_TIMEOUT_MS = 10_000;
/** Sessions a person may open per local day (a reconnect after a dropped call counts). */
export const REALTIME_SESSIONS_PER_DAY = 8;

/**
 * USD per million tokens (Google's Live API prices for gemini-3.8-live and its extended-thinking variant, read 4 Nov 2026).
 * An estimate for the budget guard, not an invoice. Google lists no cached rate for Live, so cached tokens count at the text rate.
 */
interface RealtimePrice {
  audioIn: number;
  textIn: number;
  cachedIn: number;
  audioOut: number;
  textOut: number;
}
const LIVE_PRICE: RealtimePrice = { audioIn: 3, textIn: 0.75, cachedIn: 0.75, audioOut: 12, textOut: 4.5 };
const REALTIME_PRICES: Record<string, RealtimePrice> = {
  'gemini-3.8-live': LIVE_PRICE,
  'gemini-3.8-live-extended-thinking': LIVE_PRICE,
};

const RecordAnswersArgs = z.object({
  answers: z
    .array(z.object({ questionId: z.string().max(40), value: z.unknown(), confidence: z.number().min(0).max(1).default(0.8) }))
    .max(12),
});
const ConfirmAnswersArgs = z.object({ accept: z.boolean() });

/**
 * Realtime voice for the Milo conversation. The app opens a Gemini Live WebSocket straight to Google with an ephemeral
 * token minted here (the Gemini key never reaches the phone). The model hears and speaks; every answer goes through
 * the same server engine as a typed reply (`record_answers` / `confirm_answers`), so validation, the
 * under-18 rules and saving stay on the server.
 */
@Injectable()
export class RealtimeService {
  constructor(
    @InjectModel('Conversation') private readonly conversations: Model<ConversationDoc>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly users: UsersService,
    private readonly onboarding: OnboardingTurnsService,
    private readonly content: ContentService,
    private readonly appConfig: AppConfigService,
    private readonly ai: AiService,
    private readonly provider: AiProvider,
    private readonly quota: DailyQuota,
  ) {}

  private async find(userId: string, id: string): Promise<ConversationDoc> {
    const doc = await this.conversations.findOne({ _id: id, userId: new Types.ObjectId(userId) }).lean<ConversationDoc>();
    if (!doc) throw ApiError.notFound(ERROR_CODES.CONVERSATION_NOT_FOUND, 'Conversation not found');
    if (doc.type !== 'onboarding') throw ApiError.conflict(ERROR_CODES.CONFLICT, 'Voice is available for the onboarding conversation only');
    return doc;
  }

  async createSession(userId: string, conversationId: string): Promise<RealtimeSession> {
    const conv = await this.find(userId, conversationId);
    if (conv.status === 'completed') throw ApiError.conflict(ERROR_CODES.CONFLICT, 'This conversation is finished');
    const user = await this.users.requireActive(userId);

    const flags = { ...CONFIG_DEFAULTS.flags, ...(await this.appConfig.get<Record<string, boolean>>('flags', {})) };
    if (!flags['voice.realtime']) throw ApiError.forbidden(ERROR_CODES.FEATURE_DISABLED, 'Voice conversation is not available right now');
    if (!this.provider.configured) {
      throw new ApiError(ERROR_CODES.AI_UNAVAILABLE, 'Milo’s voice is not switched on yet', HttpStatus.SERVICE_UNAVAILABLE, { reason: 'not_configured', retryAfterSec: 600 });
    }
    await this.ai.assertAvailable('realtime');
    await this.quota.assertAvailable('realtime', userId, user.timezone, REALTIME_SESSIONS_PER_DAY, true, 'Voice sessions used up for today');

    const prompt = await this.content.activePrompt('onboarding-voice');
    if (!prompt) throw new AiUnavailableError('provider_error', 300);
    const start = await this.onboarding.realtimeStart(conv);
    const locale = requestLocale();
    const lang = localeInfo(locale);
    const instructions = `${prompt.staticPrefix}\n\n${fillTemplate(prompt.dynamicTemplate ?? '', {
      languageName: lang.aiName,
      languageNote:
        'Speak this language from the first word. If the user clearly speaks another language, or mixes in English or Bangla written in Latin letters, follow them. Say numbers aloud the way a person would; keep tool values as ASCII digits. This overrides any instruction above about UK English.',
      sessionKind: start.sessionKind,
      knownName: start.knownName || 'not given yet',
      turnId: start.turnId,
      firstInstruction: start.firstInstruction,
      openQuestionsJson: start.openQuestionsJson,
      synonymsJson: start.synonymsJson,
    })}`;

    const model = await this.ai.modelFor('realtime', this.config.GEMINI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL);
    // A voice setting left over from before Gemini (a name from before Gemini) is not a Gemini voice: the default is used instead.
    const voice = voiceOrDefault(await this.appConfig.get<string>('ai.realtime.voice', DEFAULT_VOICE));
    const breaker = this.ai.breaker('realtime');
    if (!breaker.allow()) throw new AiUnavailableError('circuit_open', breaker.retryAfterSec() || 30);

    let secret;
    try {
      secret = await this.provider.realtimeSecret({
        model,
        voice,
        instructions,
        tools: await this.tools(),
        expiresAfterSec: SECRET_TTL_SEC,
        sessionSec: REALTIME_MAX_SECONDS + SESSION_GRACE_SEC,
        maxOutputTokens: REALTIME_MAX_OUTPUT_TOKENS,
        silenceMs: REALTIME_SILENCE_MS,
        timeoutMs: SECRET_TIMEOUT_MS,
      });
    } catch {
      breaker.record(false);
      throw new AiUnavailableError('provider_error', 30);
    }
    breaker.record(true);
    await this.quota.consume('realtime', userId, user.timezone);
    return {
      clientSecret: secret.value,
      expiresAt: new Date(secret.expiresAt * 1000).toISOString(),
      model: secret.model,
      voice,
      callsUrl: secret.callsUrl,
      maxSeconds: REALTIME_MAX_SECONDS,
      sessionKind: start.sessionKind,
    };
  }

  /** A tool call from the Realtime model, forwarded by the app. Goes through the same engine as a typed turn. */
  async tool(userId: string, conversationId: string, req: RealtimeToolRequest): Promise<RealtimeToolResult> {
    const conv = await this.find(userId, conversationId);
    let reply;
    let outcome: 'clarify' | 'confirm' | 'saved' | 'discarded';
    if (req.name === 'record_answers') {
      const args = RecordAnswersArgs.safeParse(req.arguments);
      if (!args.success) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'record_answers needs answers: [{questionId, value, confidence}]');
      ({ reply, outcome } = await this.onboarding.realtimeRecord(conv, args.data.answers));
    } else {
      const args = ConfirmAnswersArgs.safeParse(req.arguments);
      if (!args.success) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'confirm_answers needs accept: true or false');
      reply = await this.onboarding.confirm(conv, args.data.accept);
      outcome = args.data.accept ? 'saved' : 'discarded';
    }
    const out = await this.onboarding.realtimeToolOutput(conv, reply, outcome);
    const full: MiloReply = { ...reply, conversationId, messageId: null };
    return { output: JSON.stringify(out), reply: full };
  }

  /** The app reports the tokens of a finished session so the monthly budget guard sees the cost. */
  async usage(userId: string, conversationId: string, u: RealtimeUsageRequest): Promise<void> {
    await this.find(userId, conversationId);
    const model = await this.ai.modelFor('realtime', this.config.GEMINI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL);
    const p = REALTIME_PRICES[model] ?? LIVE_PRICE;
    const freshAudioIn = Math.max(0, u.inputAudioTokens - u.cachedInputTokens);
    const cost = (freshAudioIn * p.audioIn + u.inputTextTokens * p.textIn + u.cachedInputTokens * p.cachedIn + u.outputAudioTokens * p.audioOut + u.outputTextTokens * p.textOut) / 1_000_000;
    await this.ai.recordUsage(
      'realtime',
      model,
      { inputTokens: u.inputAudioTokens + u.inputTextTokens, cachedTokens: u.cachedInputTokens, outputTokens: u.outputAudioTokens + u.outputTextTokens },
      Math.round(cost * 1e6) / 1e6,
    );
  }

  /** Tool definitions: the answer shape is the one the extraction prompt already defines, so both readers agree. */
  private async tools(): Promise<RealtimeToolDeclaration[]> {
    const extract = await this.content.activePrompt('onboarding-extract');
    const schema = extract ? schemaFromPrompt(extract.content) : undefined;
    const answers = (schema?.properties as Record<string, unknown> | undefined)?.answers ?? { type: 'array', items: { type: 'object' } };
    return [
      {
        name: 'record_answers',
        description:
          'Save what the user just said as answers to the OPEN questions. Call it as soon as the reply answers any open question, before you speak. Never guess; never record age, sex, height or weight unless the user stated it explicitly.',
        parameters: { type: 'object', additionalProperties: false, required: ['answers'], properties: { answers } },
      },
      {
        name: 'confirm_answers',
        description: 'After a needs_confirmation result and the user’s spoken yes or no: accept true saves the noted answers, false discards them.',
        parameters: { type: 'object', additionalProperties: false, required: ['accept'], properties: { accept: { type: 'boolean' } } },
      },
    ];
  }
}
