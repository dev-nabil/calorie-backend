import { Controller, Get, HttpCode, Put, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ERROR_CODES } from '../../shared';
import { Public } from '../../common/auth/auth.decorators';
import { ApiError } from '../../common/errors/api-error';
import { isSafeKey, LocalStorageService, StorageService } from '../../infra/storage/storage';

/**
 * The local storage driver's file endpoints: the presigned PUT and signed GET URLs point here
 * (`/v1/dev/uploads`, a path kept for URL compatibility). Loaded whenever STORAGE_DRIVER=local, also with
 * DEV_ROUTES off (a test server on Render, for example); production requires s3, so never there.
 * Every request carries an HMAC signature with an expiry, and an upload has its size and type fixed.
 */
@ApiExcludeController()
@Controller('dev/uploads')
export class LocalUploadsController {
  constructor(private readonly storage: StorageService) {}

  private local(): LocalStorageService {
    if (!(this.storage instanceof LocalStorageService)) throw ApiError.notFound(ERROR_CODES.NOT_FOUND, 'Local storage is not enabled');
    return this.storage;
  }

  /** Target of presigned uploads with the local driver (signed, 5 minutes, size and type enforced). */
  @Public()
  @Put()
  @HttpCode(200)
  upload(@Query() q: Record<string, string>, @Req() req: Request): { key: string; bytes: number } {
    const storage = this.local();
    const { key = '', exp = '', sig = '', ct = '', max = '' } = q;
    if (!isSafeKey(key) || !storage.verify('PUT', key, Number(exp), sig, `${ct}\n${max}`)) {
      throw ApiError.forbidden(ERROR_CODES.FORBIDDEN, 'Upload URL is invalid or expired');
    }
    const body = req.body as unknown;
    if (req.header('content-type') !== ct || !Buffer.isBuffer(body)) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `Send the file as the raw body with Content-Type: ${ct}`);
    }
    if (body.length === 0 || body.length > Number(max)) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `File must be 1–${max} bytes`, 413);
    if (ct === 'image/jpeg' && !(body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Not a JPEG file');
    }
    storage.write(key, body);
    return { key, bytes: body.length };
  }

  @Public()
  @Get()
  download(@Query() q: Record<string, string>, @Res() res: Response): void {
    const storage = this.local();
    const { key = '', exp = '', sig = '' } = q;
    if (!isSafeKey(key) || !storage.verify('GET', key, Number(exp), sig)) throw ApiError.forbidden(ERROR_CODES.FORBIDDEN, 'URL is invalid or expired');
    const file = storage.read(key);
    if (!file) throw ApiError.notFound();
    res.setHeader('Content-Type', key.endsWith('.jpg') ? 'image/jpeg' : 'audio/mp4');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(file);
  }
}
