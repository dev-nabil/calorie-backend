import { Controller, HttpCode, HttpStatus, Logger, Post, Req } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Model, Types } from 'mongoose';
import { AI_LIMITS, ERROR_CODES, FridgeChefRequestSchema, FridgeChefResponseSchema, type FridgeChefRequest, type FridgeChefResponse } from '../../shared';
import { isPlusActive } from '../../domain/entitlements';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { clock } from '../../common/clock';
import { ApiError } from '../../common/errors/api-error';
import { requestLocale } from '../../common/http/request-context';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { integrityOk, RequireIntegrity } from '../../common/integrity/integrity';
import { DailyQuota } from '../../common/rate-limit/daily-quota';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { StorageService } from '../../infra/storage/storage';
import { AiJobRunner } from '../ai/ai-jobs';
import { AppConfigService } from '../content/app-config.service';
import type { ScanDoc } from '../scans/schemas/scans.schema';
import type { MealDoc } from '../tracking/schemas/tracking.schema';
import { ownsKey } from '../uploads/uploads.keys';
import { UsersService } from '../users/users.service';
import { FRIDGE_CHEF_JOB, FRIDGE_CHEF_TIMEOUT_MS, type FridgeChefJob } from './fridge-chef.handler';

@ApiTags('fridge-chef')
@ApiBearerAuth()
@Controller('fridge-chef')
export class FridgeChefController {
  private readonly logger = new Logger('FridgeChef');

  constructor(
    @InjectModel('Scan') private readonly scans: Model<ScanDoc>,
    @InjectModel('Meal') private readonly meals: Model<MealDoc>,
    private readonly runner: AiJobRunner,
    private readonly users: UsersService,
    private readonly quota: DailyQuota,
    private readonly appConfig: AppConfigService,
    private readonly storage: StorageService,
  ) {}

  @Post()
  @HttpCode(200)
  @Idempotent()
  @RequireIntegrity()
  @ZResponse(
    200,
    FridgeChefResponseSchema,
    'Plus. Upload one photo first (POST /uploads/presign kind meal_photo, image/jpeg, then PUT), then send its key. The photo is deleted after this call whatever happens, so a retry needs a new upload. Nothing is saved',
  )
  @ApiErrors(400, 401, 402, 403, 409, 422, 429, 502, 503)
  async cook(@CurrentUser() u: AuthUser, @ZBody(FridgeChefRequestSchema) body: FridgeChefRequest, @Req() req: Request): Promise<FridgeChefResponse> {
    const user = await this.users.requireActive(u.id);
    const key = body.uploadKey;
    // Only this user's own upload, and never a photo a scan or a meal still uses, may be read and then deleted here.
    const own = ownsKey(u.id, 'meal_photo', key);
    const inUse = own && (await this.inUse(user._id, key));
    try {
      if (!isPlusActive(user.entitlement, clock.now())) throw new ApiError(ERROR_CODES.PLUS_REQUIRED, 'Fridge chef is part of Nouri Plus', HttpStatus.PAYMENT_REQUIRED);
      if (!integrityOk(req)) throw ApiError.forbidden(ERROR_CODES.INTEGRITY_REQUIRED, 'This device could not be verified');
      if (inUse) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'This photo belongs to a scan or a meal. Upload a new one', HttpStatus.BAD_REQUEST, { field: 'uploadKey' });
      if (!own || !(await this.storage.exists(key))) {
        throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Upload the photo with POST /uploads/presign first', HttpStatus.BAD_REQUEST, { field: 'uploadKey' });
      }
      const limits = await this.appConfig.get<{ plus?: { fridgePerDay?: number } }>('limits', AI_LIMITS);
      const perDay = limits.plus?.fridgePerDay ?? AI_LIMITS.plus.fridgePerDay;
      await this.quota.assertAvailable('fridge', u.id, user.timezone, perDay, true, 'Fridge chef is used up for today. Try again tomorrow.');
      const job: FridgeChefJob = { userId: u.id, uploadKey: key, locale: requestLocale() };
      const result = await this.runner.run<FridgeChefResponse>(FRIDGE_CHEF_JOB, job, FRIDGE_CHEF_TIMEOUT_MS + 5000);
      await this.quota.consume('fridge', u.id, user.timezone); // successful answers only (OQ-38)
      return result;
    } finally {
      // The worker deletes the photo right after the model call; this covers refusals before it and a worker that timed out.
      if (own && !inUse) await this.storage.delete(key).catch((e: unknown) => this.logger.warn({ err: (e as Error).message }, 'fridge photo not deleted'));
    }
  }

  private async inUse(userId: Types.ObjectId, key: string): Promise<boolean> {
    const [scan, meal] = await Promise.all([this.scans.exists({ userId, imageKey: key }), this.meals.exists({ userId, 'photo.key': key })]);
    return Boolean(scan || meal);
  }
}
