import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AI_LIMITS, AudioManifestSchema, ERROR_CODES, SpeechRequestSchema, SpeechResponseSchema } from '../../shared';
import { isPlusActive } from '../../domain/entitlements';
import { CurrentUser, Public, type AuthUser } from '../../common/auth/auth.decorators';
import { clock } from '../../common/clock';
import { ApiError } from '../../common/errors/api-error';
import { RequireIntegrity } from '../../common/integrity/integrity';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { DailyQuota } from '../../common/rate-limit/daily-quota';
import { StorageService } from '../../infra/storage/storage';
import { AiJobRunner } from '../ai/ai-jobs';
import { CONFIG_DEFAULTS } from '../app-config/app-config.defaults';
import { AppConfigService } from '../content/app-config.service';
import { UsersService } from '../users/users.service';
import { SPEECH_JOB, TTS_TIMEOUT_MS, VoiceService } from './voice.service';

@ApiTags('voice')
@Controller()
export class VoiceController {
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
  @ZResponse(200, SpeechResponseSchema, 'WAV URL, valid 1 hour; cached per message')
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
