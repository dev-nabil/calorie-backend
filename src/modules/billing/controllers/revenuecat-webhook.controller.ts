import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { APP_CONFIG } from '../../../config/config.module';
import type { AppConfig } from '../../../config/env';
import { AdminStatusResultSchema, ERROR_CODES } from '../../../shared';
import { ApiErrors, ZResponse } from '../../../common/zod/decorators';
import { type RcEvent } from '../../../domain/entitlements/revenuecat';
import { Public } from '../../../common/auth/auth.decorators';
import { ApiError } from '../../../common/errors/api-error';
import { ZodValidationPipe } from '../../../common/zod/zod-validation.pipe';
import { BillingEventsService } from '../services/billing-events.service';

const WebhookSchema = z.object({
  api_version: z.string().optional(),
  event: z.looseObject({ id: z.string().min(1).max(200), type: z.string().min(1).max(64), app_user_id: z.string().max(200) }),
});

@ApiTags('webhooks')
@Controller('webhooks')
export class RevenueCatWebhookController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly svc: BillingEventsService,
  ) {}

  /**
   * M6-T2: shared secret in the Authorization header, idempotent by event id; always 200 once stored.
   * The secret is checked before the body is validated, so callers without it learn nothing about the payload (QA B23).
   */
  @Public()
  @Post('revenuecat')
  @HttpCode(200)
  @ZResponse(200, AdminStatusResultSchema, '{status: processed | duplicate | ignored | failed}')
  @ApiErrors(400, 401, 503)
  async revenuecat(@Req() req: Request, @Body() raw: unknown) {
    const secret = this.config.REVENUECAT_WEBHOOK_SECRET;
    if (!secret) throw new ApiError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Webhook secret not configured', 503);
    const got = Buffer.from((req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(secret);
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw ApiError.unauthenticated();
    const body = new ZodValidationPipe(WebhookSchema).transform(raw, { type: 'body' });
    return this.svc.receive(body.event as unknown as RcEvent);
  }
}
