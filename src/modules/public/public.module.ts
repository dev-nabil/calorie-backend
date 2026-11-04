import { Controller, HttpCode, Injectable, Logger, Module, Post, Req } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Model } from 'mongoose';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import {
  DeletionRequestResponseSchema,
  DeletionRequestSchema,
  ERROR_CODES,
  WaitlistRequestSchema,
  WaitlistResponseSchema,
  type WaitlistResponse,
} from '../../shared';
import { Public } from '../../common/auth/auth.decorators';
import { ApiError } from '../../common/errors/api-error';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.service';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';

/** Cloudflare Turnstile check for landing-page forms (M8-T2). */
export abstract class TurnstileVerifier {
  abstract verify(token: string, ip?: string): Promise<boolean>;
}
export class AllowTurnstileVerifier extends TurnstileVerifier {
  async verify(token: string): Promise<boolean> {
    return token.length > 0;
  }
}
export class CloudflareTurnstileVerifier extends TurnstileVerifier {
  constructor(private readonly secret: string) {
    super();
  }
  async verify(token: string, ip?: string): Promise<boolean> {
    const body = new URLSearchParams({ secret: this.secret, response: token, ...(ip ? { remoteip: ip } : {}) });
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    return res.ok && ((await res.json()) as { success?: boolean }).success === true;
  }
}

@Injectable()
class PublicService {
  private readonly logger = new Logger('PublicService');
  constructor(
    @InjectModel('Waitlist') private readonly waitlist: Model<{ email: string }>,
    @InjectModel('DeletionRequest') private readonly deletions: Model<{ email: string; reason?: string; ip: string }>,
    private readonly turnstile: TurnstileVerifier,
    private readonly limiter: RateLimiter,
  ) {}

  private async guard(token: string, ip: string, bucket: string): Promise<void> {
    await this.limiter.consume({ key: `public:${bucket}:ip:${ip}`, limit: 10, windowSec: 3600 });
    if (!(await this.turnstile.verify(token, ip))) throw ApiError.forbidden(ERROR_CODES.FORBIDDEN, 'Bot check failed');
  }

  async join(body: { email: string; turnstileToken: string; source?: string; utm?: Record<string, string> }, ip: string): Promise<WaitlistResponse> {
    await this.guard(body.turnstileToken, ip, 'waitlist');
    const r = await this.waitlist.updateOne(
      { email: body.email },
      { $setOnInsert: { email: body.email, source: body.source ?? null, utm: body.utm ?? null } },
      { upsert: true },
    );
    return { status: r.upsertedCount ? 'joined' : 'already_joined' };
  }

  /** Recorded for the deletion workflow; the response never reveals whether an account exists. */
  async requestDeletion(body: { email: string; turnstileToken: string; reason?: string }, ip: string): Promise<void> {
    await this.guard(body.turnstileToken, ip, 'deletion');
    await this.deletions.create({ email: body.email, reason: body.reason, ip });
    this.logger.log('deletion request received');
  }
}

@ApiTags('public')
@Controller('public')
class PublicController {
  constructor(private readonly svc: PublicService) {}

  @Public()
  @Post('waitlist')
  @HttpCode(200)
  @ZResponse(200, WaitlistResponseSchema, 'Landing-page waitlist; repeat sign-ups are not an error')
  @ApiErrors(400, 403, 429)
  join(@ZBody(WaitlistRequestSchema) body: Parameters<PublicService['join']>[0], @Req() req: Request): Promise<WaitlistResponse> {
    return this.svc.join(body, req.ip ?? 'unknown');
  }

  @Public()
  @Post('deletion-requests')
  @HttpCode(202)
  @ZResponse(202, DeletionRequestResponseSchema, 'Always 202 { status: "received" } (Google Play web deletion)')
  @ApiErrors(400, 403, 429)
  async deletion(@ZBody(DeletionRequestSchema) body: Parameters<PublicService['requestDeletion']>[0], @Req() req: Request) {
    await this.svc.requestDeletion(body, req.ip ?? 'unknown');
    return { status: 'received' as const };
  }
}

@Module({
  controllers: [PublicController],
  providers: [
    PublicService,
    {
      provide: TurnstileVerifier,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => (c.TURNSTILE_SECRET ? new CloudflareTurnstileVerifier(c.TURNSTILE_SECRET) : new AllowTurnstileVerifier()),
    },
  ],
})
export class PublicModule {}



