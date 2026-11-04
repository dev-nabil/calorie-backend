import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
ERROR_CODES, type WaitlistResponse
} from '../../shared';
import { ApiError } from '../../common/errors/api-error';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.service';
import { TurnstileVerifier } from './turnstile.verifier';

@Injectable()
export class PublicService {
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
