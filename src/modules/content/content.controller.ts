import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ERROR_CODES } from '../../shared';
import { Public } from '../../common/auth/auth.decorators';
import { ApiError } from '../../common/errors/api-error';
import { applyContentCaching } from '../../common/http/etag';
import { ZResponse } from '../../common/zod/decorators';
import { ContentService } from './content.service';

const ContentDocSchema = z
  .object({ kind: z.string(), version: z.number().int(), locale: z.string(), data: z.record(z.string(), z.unknown()) })
  .meta({ id: 'ContentDocument' });

/** Versioned, CDN-cacheable content (S-13). */
@ApiTags('content')
@Controller('content')
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Public()
  @Get('milo-lines')
  @ZResponse(200, ContentDocSchema, 'content/milo/lines.v1.json (ETag, Cache-Control public 300 s)')
  async miloLines(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.send(req, res, 'milo_lines', await this.content.miloLines());
  }

  @Public()
  @Get('conversation')
  @ZResponse(200, ContentDocSchema, 'content/onboarding/conversation.v1.json')
  async conversation(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const c = await this.content.conversation();
    return this.send(req, res, 'conversation', c && { version: c.version, data: c.data, locale: c.locale });
  }

  private send(req: Request, res: Response, kind: string, doc: { version: number; data: unknown; locale?: string } | null) {
    if (!doc) throw ApiError.notFound(ERROR_CODES.NOT_FOUND, 'Content not published');
    const locale = doc.locale ?? 'en';
    const body = { kind, version: doc.version, locale, data: doc.data };
    return applyContentCaching(req, res, `${kind}-${locale}-v${doc.version}`, body) ? body : undefined;
  }
}
