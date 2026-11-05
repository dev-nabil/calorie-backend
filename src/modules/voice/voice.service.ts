import { requestLocale } from '../../common/http/request-context';
import { DEFAULT_LOCALE, LOCALE_CODES, type LocaleCode } from '../../shared/locales';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { ERROR_CODES } from '../../shared';
import { ApiError } from '../../common/errors/api-error';
import { StorageService } from '../../infra/storage/storage';
import { JobHandlers } from '../../jobs/jobs.module';
import { AiJobHandlers } from '../ai/ai-jobs';
import { DEFAULT_TTS_MODEL } from '../ai/ai-models';
import { AiProvider, type SpeechResult } from '../ai/ai.provider';
import { DEFAULT_VOICE, voiceOrDefault } from '../ai/providers/gemini.provider';
import { AiService, AiUnavailableError } from '../ai/ai.service';
import { AppConfigService } from '../content/app-config.service';
import { ContentService } from '../content/content.service';
import type { MessageDoc } from '../conversations/schemas/conversations.schema';
import { canonicalLines } from './canonical-lines';

export const PRERENDER_JOB = 'prerender_lines';
export const SPEECH_JOB = 'speech';
export const TTS_TIMEOUT_MS = 20_000; // plan 8.10

/** M5-T2: Gemini text-to-speech for canonical lines (pre-rendered once per version) and Plus replies. */
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
    // A voice setting left over from before Gemini (a name from before Gemini) is not a Gemini voice: the default is used instead.
    return { model: await this.ai.modelFor('tts', DEFAULT_TTS_MODEL), voice: voiceOrDefault(await this.appConfig.get<string>('ai.tts.voice', DEFAULT_VOICE)) };
  }

  private async speak(text: string): Promise<SpeechResult> {
    const { model, voice } = await this.voice();
    await this.ai.assertAvailable('tts');
    try {
      const speech = await this.provider.speech({ model, voice, text, timeoutMs: TTS_TIMEOUT_MS });
      this.ai.breaker('tts').record(true);
      return speech;
    } catch {
      this.ai.breaker('tts').record(false);
      throw new AiUnavailableError('provider_error', 30);
    }
  }

  /** Storage prefix of a language's pre-rendered lines: English keeps `tts/<version>`, others `tts/<lang>/<version>`. Files are WAV (Gemini TTS). */
  private prefix(locale: LocaleCode, version: number): string {
    return locale === DEFAULT_LOCALE ? `tts/${version}` : `tts/${locale}/${version}`;
  }

  /** Renders missing lines of every language that has its own content to tts/[<lang>/]{version}/{lineId}.wav and writes the manifests. */
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
        const key = `${prefix}/${id}.wav`;
        keys[id] = key;
        if (await this.storage.exists(key)) continue;
        const speech = await this.speak(text);
        await this.storage.put(key, speech.audio, speech.contentType);
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
    const key = `u/${userId}/tts/${messageId}.wav`;
    if (await this.storage.exists(key)) return { key, cached: true };
    const msg = await this.messages.findOne({ _id: messageId, userId: new Types.ObjectId(userId), role: 'assistant' }).lean<MessageDoc>();
    if (!msg) throw ApiError.notFound(ERROR_CODES.NOT_FOUND, 'Message not found');
    const speech = await this.speak(msg.text);
    await this.storage.put(key, speech.audio, speech.contentType);
    return { key, cached: false };
  }
}
