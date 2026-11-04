import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AI_FEATURES, AI_LIMITS, AppConfigResponseSchema, type AppConfigResponse } from '../../shared';
import { assignExperiments, type ExperimentDef } from '../../domain/experiments';
import { OptionalAuth } from '../../common/auth/auth.decorators';
import { applyContentCaching } from '../../common/http/etag';
import { ZResponse } from '../../common/zod/decorators';
import { AppConfigService } from '../content/app-config.service';
import { ContentService } from '../content/content.service';
import { UsersService } from '../users/users.service';
import { CONFIG_DEFAULTS } from './app-config.defaults';

/** GET /v1/config (plan section 7). Public and CDN-cacheable; with a token it also returns this user's experiment variants (private). */
@ApiTags('config')
@Controller('config')
export class AppConfigController {
  constructor(
    private readonly appConfig: AppConfigService,
    private readonly content: ContentService,
    private readonly users: UsersService,
  ) {}

  @OptionalAuth()
  @ApiBearerAuth()
  @Get()
  @ZResponse(200, AppConfigResponseSchema, 'Flags, limits, min app version, legal URLs, kill switches, content versions; experiments when signed in')
  async get(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AppConfigResponse | undefined> {
    const [flags, defs, limits, minAppVersion, legal] = await Promise.all([
      this.appConfig.get('flags', CONFIG_DEFAULTS.flags),
      this.appConfig.get<Record<string, ExperimentDef>>('experiments', {}).then((stored) => ({ ...CONFIG_DEFAULTS.experiments, ...stored })),
      this.appConfig.get<Record<string, unknown>>('limits', AI_LIMITS as unknown as Record<string, unknown>),
      this.appConfig.get('minAppVersion', CONFIG_DEFAULTS.minAppVersion),
      this.appConfig.get('legal', CONFIG_DEFAULTS.legal),
    ]);
    const kill = await Promise.all(AI_FEATURES.map((f) => this.appConfig.get<boolean>(`ai.kill.${f}`, false)));
    const [q, c, l] = await Promise.all([this.content.questionSet(), this.content.conversation(), this.content.miloLines()]);
    let experiments: Record<string, string> = {};
    if (req.authUser) {
      const user = await this.users.findById(req.authUser.id);
      if (user) {
        const existing = Object.fromEntries(user.experiments instanceof Map ? user.experiments : Object.entries(user.experiments ?? {}));
        const r = assignExperiments(user._id.toString(), existing, defs);
        experiments = r.assignments;
        if (Object.keys(r.added).length) {
          await this.users.users.updateOne({ _id: user._id }, { $set: { experiments: { ...existing, ...r.assignments } } });
        }
      }
    }
    const body: AppConfigResponse = {
      flags: { ...CONFIG_DEFAULTS.flags, ...flags },
      experiments,
      limits,
      minAppVersion: { ...CONFIG_DEFAULTS.minAppVersion, ...minAppVersion },
      legal: { ...CONFIG_DEFAULTS.legal, ...legal },
      killSwitches: { vision: kill[0]!, chat: kill[1]!, extract: kill[2]!, tts: kill[3]! },
      contentVersions: { onboardingQuestions: q.version, conversation: c?.version ?? null, miloLines: l?.version ?? null },
    };
    const send = applyContentCaching(req, res, 'config', body);
    // Kill switches must reach apps within about a minute (M7 done-when).
    res.setHeader('Cache-Control', req.authUser ? 'private, no-store' : 'public, max-age=60');
    return send ? body : undefined;
  }
}
