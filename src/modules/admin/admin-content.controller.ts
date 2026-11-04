import { Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { JobQueue } from '../../jobs/background-jobs';
import { PRERENDER_JOB } from '../voice/voice.module';
import { AdminReasonRequestSchema, AdminStatusResultSchema } from '../../shared';
import { InjectModel } from '@nestjs/mongoose';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Model } from 'mongoose';
import { z } from 'zod';
import { AdminContentDocSchema, AdminContentPutSchema, ERROR_CODES } from '../../shared';
import { loadQuestionSet } from '../../domain/onboarding-engine';
import { ApiError } from '../../common/errors/api-error';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { ContentService } from '../content/content.service';
import type { ContentVersionDoc } from '../content/content.schemas';
import { Admin } from './admin-auth.controller';
import { AuditService, CurrentAdmin, type AdminSessionData } from './admin-session';

type Kind = 'onboarding_questions' | 'conversation' | 'milo_lines';
const PATHS: Record<string, Kind> = { 'onboarding-questions': 'onboarding_questions', conversation: 'conversation', 'milo-lines': 'milo_lines' };
type Json = Record<string, unknown>;

const QuestionsCopy = z.object({
  questions: z.array(z.object({ id: z.string(), text: z.string().min(1).max(300).optional(), miloLine: z.string().max(300).optional(), options: z.array(z.object({ id: z.string(), label: z.string().min(1).max(120) })).optional() })),
});
const ConversationCopy = z.object({ turns: z.array(z.object({ turn: z.number().int(), prompt: z.string().min(1).max(400) })) });
const LinesCopy = z.object({ lines: z.array(z.object({ key: z.string(), text: z.string().min(1).max(400), audio: z.unknown().optional() })) });

/** Lines with several strings (e.g. {title, sub}) are edited as `<key>#<field>` entries (BI-1). */
const FIELD_SEP = '#';

/** Editor projections (copy only, IDs never change: content/README.md versioning rules 1–2). */
export function project(kind: Kind, data: Json, version: number): Json {
  if (kind === 'onboarding_questions') {
    return {
      questions: (data.questions as Json[]).map((q) => ({
        id: q.id,
        fieldKey: q.fieldKey,
        stage: q.stage,
        type: q.type,
        text: q.text ?? '',
        miloLine: q.miloLine ?? '',
        options: ((q.options as Json[] | undefined) ?? []).map((o) => ({ id: o.id, label: o.label })),
      })),
    };
  }
  if (kind === 'conversation') {
    return { turns: (data.turns as Json[]).map((t) => ({ turn: t.turn, questionIds: t.questionIds, prompt: t.miloLine ?? '' })) };
  }
  const out: Json[] = [];
  for (const [key, v] of Object.entries((data.lines as Record<string, Record<string, unknown>>) ?? {})) {
    if (typeof v.text === 'string') out.push({ key, text: v.text, audio: { status: 'pending', version } });
    for (const [field, value] of Object.entries(v)) {
      if (field !== 'text' && typeof value === 'string') out.push({ key: `${key}${FIELD_SEP}${field}`, text: value, audio: { status: 'pending', version } });
    }
  }
  return { lines: out };
}

/** Applies a copy edit to a full content document; unknown IDs are ignored, structure never changes. */
export function applyCopy(kind: Kind, data: Json, edit: unknown): Json {
  const next = structuredClone(data);
  if (kind === 'onboarding_questions') {
    const e = QuestionsCopy.parse(edit);
    const byId = new Map((next.questions as Json[]).map((q) => [q.id as string, q]));
    for (const q of e.questions) {
      const target = byId.get(q.id);
      if (!target) continue;
      if (q.text !== undefined) target.text = q.text;
      if (q.miloLine !== undefined) target.miloLine = q.miloLine;
      for (const o of q.options ?? []) {
        const opt = ((target.options as Json[] | undefined) ?? []).find((x) => x.id === o.id);
        if (opt) opt.label = o.label;
      }
    }
  } else if (kind === 'conversation') {
    const e = ConversationCopy.parse(edit);
    for (const t of e.turns) {
      const target = (next.turns as Json[]).find((x) => x.turn === t.turn);
      if (target) target.miloLine = t.prompt;
    }
  } else {
    const e = LinesCopy.parse(edit);
    const lines = next.lines as Record<string, Json>;
    for (const l of e.lines) {
      const [key, field = 'text'] = l.key.split(FIELD_SEP) as [string, string?];
      const line = lines[key];
      if (line && typeof line[field] === 'string') line[field] = l.text;
    }
  }
  return next;
}

/** M7-T5 content editor: versioned copy edits; a stale baseVersion is a 409 conflict. */
@ApiTags('admin')
@Controller('admin/content')
export class AdminContentController {
  constructor(
    @InjectModel('ContentVersion') private readonly versions: Model<ContentVersionDoc>,
    private readonly content: ContentService,
    private readonly audit: AuditService,
    private readonly jobs: JobQueue,
  ) {}

  /** M7-T5: re-render canonical Milo audio for the current version (missing files only). */
  @Admin('content.copy.edit')
  @Post('milo-lines/prerender')
  @HttpCode(202)
  @ZResponse(202, AdminStatusResultSchema)
  async prerender(@ZBody(AdminReasonRequestSchema) body: { reason: string }, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    await this.jobs.enqueue(PRERENDER_JOB, {});
    await this.audit.log(admin, req, { action: 'content.prerender', targetType: 'milo_lines', reason: body.reason });
    return { status: 'queued' };
  }

  private kind(path: string): Kind {
    const k = PATHS[path];
    if (!k) throw ApiError.notFound();
    return k;
  }

  private async latest(kind: Kind) {
    const doc = await this.versions.findOne({ kind }).sort({ version: -1 }).lean<ContentVersionDoc & { updatedAt?: Date; createdAt?: Date }>();
    if (!doc) throw ApiError.notFound(ERROR_CODES.NOT_FOUND, 'Content not published');
    return doc;
  }

  @Admin('content.view')
  @Get(':kind')
  @ApiParam({ name: 'kind', enum: Object.keys(PATHS) })
  @ZResponse(200, AdminContentDocSchema)
  @ApiErrors(401, 403, 404)
  async get(@Param('kind') path: string) {
    const kind = this.kind(path);
    const doc = await this.latest(kind);
    return { kind, version: doc.version, data: project(kind, doc.data as Json, doc.version), publishedAt: new Date(doc.publishedAt).toISOString(), publishedBy: doc.source ?? 'seed' };
  }

  @Admin('content.copy.edit')
  @Put(':kind')
  @ApiParam({ name: 'kind', enum: Object.keys(PATHS) })
  @ZResponse(200, AdminContentDocSchema, 'Publishes a new version (copy only)')
  @ApiErrors(400, 401, 403, 404, 409)
  async put(@Param('kind') path: string, @ZBody(AdminContentPutSchema) body: z.infer<typeof AdminContentPutSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const kind = this.kind(path);
    const current = await this.latest(kind);
    if (body.baseVersion !== current.version) {
      throw ApiError.conflict(ERROR_CODES.VERSION_CONFLICT, 'Someone published a newer version. Reload and reapply your changes.', { currentVersion: current.version });
    }
    let data: Json;
    try {
      data = applyCopy(kind, current.data as Json, body.data);
    } catch (e) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Invalid content edit', 400, { message: (e as Error).message });
    }
    const version = current.version + 1;
    data.version = version;
    if (kind === 'onboarding_questions') loadQuestionSet(data); // never publish a bank the engine rejects
    try {
      await this.versions.create({ kind, version, data, publishedAt: new Date(), source: admin.email });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw ApiError.conflict(ERROR_CODES.VERSION_CONFLICT, 'Someone published at the same time. Reload.', { currentVersion: version });
      throw e;
    }
    this.content.clearCache();
    if (kind === 'milo_lines' || kind === 'conversation') await this.jobs.enqueue(PRERENDER_JOB, {}, { jobId: `prerender-${kind}-${version}` });
    await this.audit.log(admin, req, { action: 'content.publish', targetType: kind, targetId: String(version), reason: body.reason, diff: { from: current.version, to: version } });
    return this.get(path);
  }
}
