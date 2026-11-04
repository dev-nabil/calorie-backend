import { requestLocale } from '../../common/http/request-context';
import { DEFAULT_LOCALE, LOCALE_CODES, type LocaleCode } from '../../shared/locales';
import { Controller, Get, HttpCode, Injectable, Logger, Module, OnModuleInit, Post } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types, type Model } from 'mongoose';
import { AI_LIMITS, AudioManifestSchema, ERROR_CODES, SpeechRequestSchema, SpeechResponseSchema } from '../../shared';
import { isPlusActive } from '../../domain/entitlements';
import { CurrentUser, Public, type AuthUser } from '../../common/auth/auth.decorators';
import { clock } from '../../common/clock';
import { ApiError } from '../../common/errors/api-error';
import { RequireIntegrity } from '../../common/integrity/integrity';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { DailyQuota } from '../../common/rate-limit/daily-quota';
import { StorageService } from '../../infra/storage/storage';
import { JobHandlers } from '../../jobs/background-jobs';
import { AiJobHandlers, AiJobRunner } from '../ai/ai-jobs';
import { AiProvider } from '../ai/ai.provider';
import { AiService, AiUnavailableError } from '../ai/ai.service';
import { CONFIG_DEFAULTS } from '../app-config/app-config.controller';
import { AppConfigService } from '../content/app-config.service';
import { ContentService } from '../content/content.service';
import type { MessageDoc } from '../conversations/conversations.schemas';
import { UsersService } from '../users/users.service';

export const PRERENDER_JOB = 'prerender_lines';
const SPEECH_JOB = 'speech';
const TTS_TIMEOUT_MS = 20_000; // plan 8.10

/** Canonical lines: everything without {placeholders} (lines.v1.json `prerender`), plus conversation turn lines. */
export function canonicalLines(lines: unknown, conversation: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(((lines as { lines?: Record<string, Record<string, unknown>> })?.lines) ?? {})) {
    for (const [field, text] of Object.entries(v)) {
      if (typeof text !== 'string' || text.includes('{')) continue;
      out[field === 'text' ? id : `${id}.${field}`] = text;
    }
  }
  for (const t of ((conversation as { turns?: { turn: number; miloLine?: string; askOne?: Record<string, string> }[] })?.turns) ?? []) {
    if (t.miloLine && !t.miloLine.includes('{')) out[`conversation.turn${t.turn}`] = t.miloLine;
    for (const [q, text] of Object.entries(t.askOne ?? {})) if (!text.includes('{')) out[`conversation.turn${t.turn}.${q}`] = text;
  }
  return out;
}

/** M5-T2: OpenAI text-to-speech for canonical lines (pre-rendered once per version) and Plus replies. */
@Injectable()
export class VoiceService implements OnModuleInit {
  private readonly logger = new Logger('Voice');

  constructor(
    @InjectModel('Message') private readonly messages: Model<MessageDoc>,
    private readonly jobs: JobHandlers,
    private readonly aiJobs: AiJobHandlers,
    private readonly ai: AiService,
    private readonly provider: AiProvider,
    private readonly storage: StorageService,
    private readonly content: ContentService,
    private readonly appConfig: AppConfigService,
  ) {}

  onModuleInit(): void {
    this.jobs.register(PRERENDER_JOB, () => this.prerender());
    this.aiJobs.register(SPEECH_JOB, (p) => this.renderMessage(p as { userId: string; messageId: string }));
  }

  private async voice(): Promise<{ model: string; voice: string }> {
    return { model: await this.ai.modelFor('tts', 'gpt-4o-mini-tts'), voice: await this.appConfig.get('ai.tts.voice', 'alloy') };
  }

  private async speak(text: string): Promise<Buffer> {
    const { model, voice } = await this.voice();
    await this.ai.assertAvailable('tts');
    try {
      const audio = (await this.provider.speech({ model, voice, text, timeoutMs: TTS_TIMEOUT_MS })).audio;
      this.ai.breaker('tts').record(true);
      return audio;
    } catch {
      this.ai.breaker('tts').record(false);
      throw new AiUnavailableError('provider_error', 30);
    }
  }

  /** Storage prefix of a language's pre-rendered lines: English keeps `tts/<version>`, others `tts/<lang>/<version>`. */
  private prefix(locale: LocaleCode, version: number): string {
    return locale === DEFAULT_LOCALE ? `tts/${version}` : `tts/${locale}/${version}`;
  }

  /** Renders missing lines of every language that has its own content to tts/[<lang>/]{version}/{lineId}.mp3 and writes the manifests. */
  async prerender(): Promise<{ version: number; rendered: number; total: number }> {
    const out = { version: 0, rendered: 0, total: 0 };
    for (const locale of LOCALE_CODES) {
      const lines = await this.content.miloLines(locale);
      if (!lines || lines.locale !== locale) continue; // no own content for this language: nothing to render
      const conv = await this.content.conversation(locale);
      const all = canonicalLines(lines.data, conv?.locale === locale ? conv.data : undefined);
      const keys: Record<string, string> = {};
      let rendered = 0;
      const prefix = this.prefix(locale, lines.version);
      for (const [id, text] of Object.entries(all)) {
        const key = `${prefix}/${id}.mp3`;
        keys[id] = key;
        if (await this.storage.exists(key)) continue;
        await this.storage.put(key, await this.speak(text), 'audio/mpeg');
        rendered++;
      }
      await this.storage.put(`${prefix}/manifest.json`, Buffer.from(JSON.stringify({ version: lines.version, locale, keys })), 'application/json');
      this.logger.log({ locale, version: lines.version, rendered, total: Object.keys(all).length }, 'pre-render done');
      if (locale === DEFAULT_LOCALE) out.version = lines.version;
      out.rendered += rendered;
      out.total += Object.keys(all).length;
    }
    return out;
  }

  /** Manifest for the request's language; a language without its own audio gets an empty list (the app then speaks on the device). */
  async manifest(): Promise<{ version: number | null; locale: string; lines: Record<string, string> }> {
    const want = requestLocale();
    const lines = await this.content.miloLines(want);
    if (!lines) return { version: null, locale: want, lines: {} };
    if (lines.locale !== want) return { version: lines.version, locale: want, lines: {} };
    const raw = await this.storage.get(`${this.prefix(want, lines.version)}/manifest.json`);
    if (!raw) return { version: lines.version, locale: want, lines: {} };
    const { keys } = JSON.parse(raw.toString('utf8')) as { keys: Record<string, string> };
    return { version: lines.version, locale: want, lines: Object.fromEntries(Object.entries(keys).map(([id, k]) => [id, this.storage.signedGetUrl(k, 24 * 3600)])) };
  }

  /** Worker job (queue `ai`): renders one coach reply, cached per message. */
  async renderMessage({ userId, messageId }: { userId: string; messageId: string }): Promise<{ key: string; cached: boolean }> {
    const key = `u/${userId}/tts/${messageId}.mp3`;
    if (await this.storage.exists(key)) return { key, cached: true };
    const msg = await this.messages.findOne({ _id: messageId, userId: new Types.ObjectId(userId), role: 'assistant' }).lean<MessageDoc>();
    if (!msg) throw ApiError.notFound(ERROR_CODES.NOT_FOUND, 'Message not found');
    await this.storage.put(key, await this.speak(msg.text), 'audio/mpeg');
    return { key, cached: false };
  }
}

@ApiTags('voice')
@Controller()
class VoiceController {
  constructor(
    private readonly voice: VoiceService,
    private readonly users: UsersService,
    private readonly appConfig: AppConfigService,
    private readonly runner: AiJobRunner,
    private readonly storage: StorageService,
    private readonly quota: DailyQuota,
  ) {}

  /** Signed URLs of pre-rendered canonical lines for the current lines version (empty until rendered). */
  @Public()
  @Get('content/audio')
  @ZResponse(200, AudioManifestSchema)
  manifest() {
    return this.voice.manifest();
  }

  /** Plus spoken coach replies (flag voice.cloudReplies + the user's voiceReplies setting), 50/day. */
  @ApiBearerAuth()
  @Post('voice/speech')
  @HttpCode(200)
  @RequireIntegrity()
  @ZResponse(200, SpeechResponseSchema, 'MP3 URL, valid 1 hour; cached per message')
  @ApiErrors(400, 401, 402, 403, 404, 429, 503)
  async speech(@CurrentUser() u: AuthUser, @ZBody(SpeechRequestSchema) body: { messageId: string }) {
    const user = await this.users.requireActive(u.id);
    const flags = { ...CONFIG_DEFAULTS.flags, ...(await this.appConfig.get<Record<string, boolean>>('flags', {})) };
    if (!flags['voice.cloudReplies']) throw ApiError.forbidden(ERROR_CODES.FEATURE_DISABLED, 'Spoken replies are not available yet');
    if (!isPlusActive(user.entitlement, clock.now())) throw new ApiError(ERROR_CODES.PLUS_REQUIRED, 'Spoken replies are part of Nouri Plus', 402);
    if (!user.flags?.voiceReplies) throw ApiError.forbidden(ERROR_CODES.FEATURE_DISABLED, 'Turn on Milo’s voice replies in Settings');
    const limits = await this.appConfig.get('limits', AI_LIMITS);
    const perDay = (limits.plus as { spokenRepliesPerDay?: number }).spokenRepliesPerDay ?? 50;
    await this.quota.assertAvailable('tts', u.id, user.timezone, perDay, true, 'Daily spoken replies used up');
    const r = await this.runner.run<{ key: string; cached: boolean }>(SPEECH_JOB, { userId: u.id, messageId: body.messageId }, TTS_TIMEOUT_MS + 5000);
    if (!r.cached) await this.quota.consume('tts', u.id, user.timezone);
    return { url: this.storage.signedGetUrl(r.key, 3600), cached: r.cached };
  }
}

@Module({ controllers: [VoiceController], providers: [VoiceService], exports: [VoiceService] })
export class VoiceModule {}

@Module({ providers: [VoiceService] })
export class VoiceWorkerModule {}

