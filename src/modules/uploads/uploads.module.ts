import { randomUUID } from 'node:crypto';
import { Controller, HttpCode, Module, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ERROR_CODES, PresignRequestSchema, PresignResponseSchema, UPLOAD_KINDS, type PresignRequest, type PresignResponse } from '../../shared';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { ApiError } from '../../common/errors/api-error';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.service';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { StorageService } from '../../infra/storage/storage';
import { UsersService } from '../users/users.service';

export const PRESIGN_TTL_SEC = 300; // plan section 14: presigned PUT valid for 5 minutes

/** Keys are sharded by user (plan section 15): u/<userId>/<kind>/<yyyy>/<mm>/<uuid>.<ext>. */
export function uploadKey(userId: string, kind: keyof typeof UPLOAD_KINDS, now = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `u/${userId}/${kind}/${yyyy}/${mm}/${randomUUID()}.${UPLOAD_KINDS[kind].ext}`;
}

export function ownsKey(userId: string, kind: keyof typeof UPLOAD_KINDS, key: string): boolean {
  return key.startsWith(`u/${userId}/${kind}/`);
}

@ApiTags('uploads')
@ApiBearerAuth()
@Controller('uploads')
class UploadsController {
  constructor(
    private readonly storage: StorageService,
    private readonly users: UsersService,
    private readonly limiter: RateLimiter,
  ) {}

  @Post('presign')
  @HttpCode(200)
  @ZResponse(200, PresignResponseSchema, 'PUT the file to uploadUrl with `headers` within 5 minutes, then use `key`')
  @ApiErrors(400, 401, 413, 429)
  async presign(@CurrentUser() u: AuthUser, @ZBody(PresignRequestSchema) body: PresignRequest): Promise<PresignResponse> {
    await this.users.requireActive(u.id);
    await this.limiter.consume({ key: `presign:user:${u.id}`, limit: 60, windowSec: 3600 });
    // Allowed during an AI outage: "Save photo and finish later" needs the upload (B21). POST /scans refuses instead.
    const spec = UPLOAD_KINDS[body.kind];
    if (!(spec.contentTypes as readonly string[]).includes(body.contentType)) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `contentType must be one of ${spec.contentTypes.join(', ')}`);
    }
    if (body.bytes !== undefined && body.bytes > spec.maxBytes) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `File is larger than ${spec.maxBytes} bytes`, 413, { maxBytes: spec.maxBytes });
    }
    const key = uploadKey(u.id, body.kind);
    const put = this.storage.presignPut(key, body.contentType, spec.maxBytes, PRESIGN_TTL_SEC);
    return {
      uploadUrl: put.url,
      method: 'PUT',
      headers: put.headers,
      key,
      maxBytes: spec.maxBytes,
      expiresAt: new Date(Date.now() + PRESIGN_TTL_SEC * 1000).toISOString(),
    };
  }
}

@Module({ controllers: [UploadsController] })
export class UploadsModule {}
