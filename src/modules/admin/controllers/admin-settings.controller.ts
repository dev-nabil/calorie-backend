import { Controller, Get, HttpCode, Post, Put, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminPutSettingSchema, AdminReasonRequestSchema, AdminSettingSchema, AdminSettingsSchema } from '../../../shared';
import { ApiErrors, ZBody, ZParam, ZResponse } from '../../../common/zod/decorators';
import { SETTING_GROUPS } from '../../settings/settings.registry';
import { SettingsService } from '../../settings/settings.service';
import { AuditService } from '../services/audit.service';
import { CurrentAdmin } from '../security/admin.decorators';
import { type AdminSessionData } from '../security/admin-session.types';
import { Admin } from './admin-auth.controller';

const SettingKeyParam = z.string().min(1).max(64).regex(/^[a-zA-Z0-9.]+$/);

/**
 * Runtime settings that used to be environment variables (models, scan tuning and caps, sign-in client
 * IDs, email sender, integrity, barcode lookups). A change reaches every instance within 30 seconds.
 * Secrets never appear here; they stay in the server environment.
 */
@ApiTags('admin')
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Admin('settings.view')
  @Get()
  @ZResponse(200, AdminSettingsSchema)
  async list() {
    return {
      groups: Object.entries(SETTING_GROUPS).map(([id, g]) => ({ id, label: g.label, description: g.description })),
      items: await this.settings.list(),
    };
  }

  @Admin('settings.edit')
  @Put(':key')
  @ZResponse(200, AdminSettingSchema)
  @ApiErrors(400, 401, 403, 404)
  async put(@ZParam('key', SettingKeyParam) raw: string, @ZBody(AdminPutSettingSchema) body: z.infer<typeof AdminPutSettingSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const key = this.settings.parseKey(raw);
    const before = await this.settings.get(key);
    const after = await this.settings.set(key, body.value, admin.email, body.reason);
    await this.audit.log(admin, req, { action: 'setting.set', targetType: 'setting', targetId: key, reason: body.reason, diff: { value: [before, after] } });
    return this.settings.view(key);
  }

  /** Back to the code default. */
  @Admin('settings.edit')
  @Post(':key/reset')
  @HttpCode(200)
  @ZResponse(200, AdminSettingSchema)
  @ApiErrors(400, 401, 403, 404)
  async reset(@ZParam('key', SettingKeyParam) raw: string, @ZBody(AdminReasonRequestSchema) body: z.infer<typeof AdminReasonRequestSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const key = this.settings.parseKey(raw);
    const before = await this.settings.get(key);
    await this.settings.reset(key);
    await this.audit.log(admin, req, { action: 'setting.reset', targetType: 'setting', targetId: key, reason: body.reason, diff: { value: [before, this.settings.defaultOf(key)] } });
    return this.settings.view(key);
  }
}
