import { Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CreateScanRequestSchema, RecalculateScanRequestSchema, RecalculatedScanSchema, ScanSchema, UuidSchema, type CreateScanRequest, type RecalculateScanRequest, type RecalculatedScan, type Scan } from '../../shared';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { noStore } from '../../common/http/etag';
import { integrityOk, RequireIntegrity } from '../../common/integrity/integrity';
import { ApiErrors, ZBody, ZParam, ZResponse } from '../../common/zod/decorators';
import { UsersService } from '../users/users.service';
import { ScansService } from './services/scans.service';

const FINAL = new Set(['succeeded', 'failed', 'rejected']);
const SSE_MAX_MS = 40_000;
export const SSE_POLL_MS = 1000;

@ApiTags('scans')
@ApiBearerAuth()
@Controller('scans')
export class ScansController {
  constructor(
    private readonly scans: ScansService,
    private readonly users: UsersService,
  ) {}

  @Post()
  @RequireIntegrity()
  @ZResponse(202, ScanSchema, 'Queued; poll GET /scans/{scanId}. Idempotent by scanId (no Idempotency-Key needed)')
  @ZResponse(200, ScanSchema, 'Existing scan for this scanId, or the stored result for the same photo within 24 h (deduped, no charge)')
  @ApiErrors(400, 401, 402, 403, 409, 429, 503)
  async create(
    @CurrentUser() u: AuthUser,
    @ZBody(CreateScanRequestSchema) body: CreateScanRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Scan> {
    const user = await this.users.requireActive(u.id);
    const [scan, created] = await this.scans.create(u.id, body, integrityOk(req), user.timezone, undefined, { ip: req.ip, deviceId: req.header('X-Device-Id') ?? undefined });
    res.status(created ? 202 : 200);
    return scan;
  }

  @Post(':scanId/recalculate')
  @HttpCode(200)
  @ZResponse(200, RecalculatedScanSchema, 'Portion and name corrections from the stored per-100-gram values. No model call, no charge, nothing saved')
  @ApiErrors(400, 401, 404, 409, 429)
  recalculate(@CurrentUser() u: AuthUser, @ZParam('scanId', UuidSchema) scanId: string, @ZBody(RecalculateScanRequestSchema) body: RecalculateScanRequest): Promise<RecalculatedScan> {
    return this.scans.recalculate(u.id, scanId, body);
  }

  /** Server-sent events: `event: status` with the Scan on every change; ends on a final status or after 40 s. */
  @Get(':scanId/events')
  @ApiProduces('text/event-stream')
  @ZResponse(200, ScanSchema, 'text/event-stream: `event: status` with a Scan per change')
  @ApiErrors(400, 401, 404)
  async events(@CurrentUser() u: AuthUser, @ZParam('scanId', UuidSchema) scanId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    let last = await this.scans.get(u.id, scanId); // 404 before the stream opens
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (s: Scan) => res.write(`event: status\ndata: ${JSON.stringify(s)}\n\n`);
    send(last);
    let closed = false;
    req.on('close', () => (closed = true));
    const deadline = Date.now() + SSE_MAX_MS;
    while (!closed && !FINAL.has(last.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SSE_POLL_MS));
      const next = await this.scans.get(u.id, scanId);
      if (next.status !== last.status) send(next);
      last = next;
    }
    if (!closed) res.end();
  }

  @Get(':scanId')
  @ZResponse(200, ScanSchema, 'Poll at 1, 2, 3, 4 s then every 3 s, up to 40 s')
  @ApiErrors(400, 401, 404)
  get(@CurrentUser() u: AuthUser, @ZParam('scanId', UuidSchema) scanId: string, @Res({ passthrough: true }) res: Response): Promise<Scan> {
    noStore(res);
    return this.scans.get(u.id, scanId);
  }
}
