import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ERROR_CODES, MealTranscribeOutputSchema, type MealTranscribeResponse } from '../../shared';
import { ApiError } from '../../common/errors/api-error';
import { AiJobs } from '../ai/ai-jobs';
import { AiProvider } from '../ai/ai.provider';
import { DEFAULT_TEXT_MODEL } from '../ai/ai-models';
import { AiService } from '../ai/ai.service';
import { ContentService } from '../content/content.service';

export const MEAL_TRANSCRIBE_JOB = 'meal_transcribe';
export const MEAL_TRANSCRIBE_TIMEOUT_MS = 20_000;

/** The composer and POST /meals/describe take at most this many characters. */
const MAX_TEXT = 500;

/** Used when no prompt row exists yet (a fresh database before content seeding). */
const FALLBACK_INSTRUCTIONS =
  'Transcribe what the person says about their food, word for word, in the language and script they speak. Write numbers as digits. Return JSON only.';

export interface TranscribeJob {
  audio: Buffer;
  mimeType: string;
  /** chat-transcribe for a message to Milo (questions too); meal-transcribe (default) for food logging. */
  promptKey?: 'meal-transcribe' | 'chat-transcribe';
  /** Longest text kept (the chat composer takes 1000 characters). */
  maxText?: number;
}

/**
 * Spoken food logging (POST /meals/transcribe): one Gemini call that turns a short recording into the words the
 * person said, in the language they said them. No analysis here: the app puts the text in the composer, the person
 * can edit it, and Send goes through POST /meals/describe as typed text does. The audio is never stored.
 */
@Injectable()
export class MealTranscribeHandler implements OnModuleInit {
  private readonly log = new Logger(MealTranscribeHandler.name);

  constructor(
    private readonly handlers: AiJobs,
    private readonly ai: AiService,
    private readonly provider: AiProvider,
    private readonly content: ContentService,
  ) {}

  onModuleInit(): void {
    this.handlers.register(MEAL_TRANSCRIBE_JOB, (p) => this.handle(p as TranscribeJob));
  }

  async handle({ audio, mimeType, promptKey = 'meal-transcribe', maxText = MAX_TEXT }: TranscribeJob): Promise<MealTranscribeResponse> {
    const prompt = (await this.content.activePrompt(promptKey)) ?? (await this.content.activePrompt('meal-transcribe'));
    const model = prompt?.model || (await this.ai.modelFor('extract', DEFAULT_TEXT_MODEL));
    const res = await this.ai.runOrUnavailable('extract', () =>
      this.provider.structured({
        task: 'meal_transcribe',
        model,
        instructions: prompt?.staticPrefix ?? FALLBACK_INSTRUCTIONS,
        context: prompt?.dynamicTemplate?.trim() || 'Transcribe the recording above.',
        audio: { bytes: audio, mimeType },
        timeoutMs: MEAL_TRANSCRIBE_TIMEOUT_MS,
        maxOutputTokens: Number(prompt?.params?.maxOutputTokens) || 400,
      }),
    );
    const parsed = MealTranscribeOutputSchema.safeParse(res.output);
    if (!parsed.success) {
      this.log.warn(`meal_transcribe output rejected: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      throw new ApiError(ERROR_CODES.AI_UNAVAILABLE, 'The recording could not be read. Try again or type it.', HttpStatus.BAD_GATEWAY);
    }
    const text = parsed.data.text.replace(/\s+/g, ' ').trim().slice(0, maxText);
    // "ok" with nothing in it is silence; words with another status are kept (the person can still edit them).
    const status = text ? 'ok' : parsed.data.status === 'ok' ? 'silence' : parsed.data.status;
    return { status, text: status === 'ok' ? text : '', language: parsed.data.language?.trim().slice(0, 16) || null };
  }
}
