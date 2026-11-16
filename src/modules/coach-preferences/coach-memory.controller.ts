import { Controller, Delete, Get, HttpCode, Patch, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  CoachMemorySchema,
  MemoryItemSchema,
  PatchMemoryRequestSchema,
  PatchMemorySettingsRequestSchema,
  type CoachMemory,
  type MemoryItem,
  type PatchMemoryRequest,
  type PatchMemorySettingsRequest,
} from '../../shared';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { noStore } from '../../common/http/etag';
import { ApiErrors, ZBody, ZParam, ZResponse } from '../../common/zod/decorators';
import { CoachMemoryService } from './coach-memory.service';

const MemoryIdSchema = z.string().regex(/^m_[a-f0-9]{20}$/, 'Expected a memory id');

/** "What Milo knows about me" (Milo buddy, contract §6). */
@ApiTags('coach')
@ApiBearerAuth()
@Controller('coach/memory')
export class CoachMemoryController {
  constructor(private readonly memory: CoachMemoryService) {}

  @Get()
  @ZResponse(200, CoachMemorySchema, 'Profile facts (read-only), the notes the person added (Plus) and the memories learned in chat, with the memory settings and how long chat history is kept')
  @ApiErrors(401)
  get(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response): Promise<CoachMemory> {
    noStore(res);
    return this.memory.view(u.id);
  }

  @Patch('settings')
  @ZResponse(200, CoachMemorySchema, 'chatMemory false: chat memories are not used and none are proposed; replyLength applies to everyone')
  @ApiErrors(400, 401)
  settings(@CurrentUser() u: AuthUser, @ZBody(PatchMemorySettingsRequestSchema) body: PatchMemorySettingsRequest): Promise<CoachMemory> {
    return this.memory.patchSettings(u.id, body);
  }

  @Patch(':id')
  @ZResponse(200, MemoryItemSchema, 'The edit wins over what was learned; older chat context is no longer sent to Milo')
  @ApiErrors(400, 401, 404)
  edit(@CurrentUser() u: AuthUser, @ZParam('id', MemoryIdSchema) id: string, @ZBody(PatchMemoryRequestSchema) body: PatchMemoryRequest): Promise<MemoryItem> {
    return this.memory.edit(u.id, id, body.text);
  }

  @Delete(':id')
  @HttpCode(204)
  @ZResponse(204, null, 'Deleted, and removed from everything derived from it (summaries, history sent to Milo)')
  @ApiErrors(401, 404)
  async remove(@CurrentUser() u: AuthUser, @ZParam('id', MemoryIdSchema) id: string): Promise<void> {
    await this.memory.remove(u.id, id);
  }

  @Delete()
  @HttpCode(204)
  @ZResponse(204, null, 'Clears every memory learned in chat; notes, profile, diary and chat history stay')
  @ApiErrors(401)
  async clear(@CurrentUser() u: AuthUser): Promise<void> {
    await this.memory.clear(u.id);
  }
}
