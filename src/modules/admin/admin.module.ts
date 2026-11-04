import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminAuthController } from './admin-auth.controller';
import { AdminContentController } from './admin-content.controller';
import { AdminMiscController } from './admin-misc.controller';
import { AdminUsersController } from './admin-users.controller';
import { AdminBillingController } from './admin-billing.controller';
import { AdminAiController } from './admin-ai.controller';
import { AdminTeamController } from './admin-team.controller';
import { BillingModule } from '../billing/billing.module';
import { AdminGuard, AdminSessions, AuditService } from './admin-session';

/** /v1/admin/* (M7 endpoints): session cookie + TOTP, CSRF, server-side roles, audit log. */
@Module({
  imports: [BillingModule],
  controllers: [AdminAuthController, AdminUsersController, AdminContentController, AdminMiscController, AdminBillingController, AdminAiController, AdminTeamController],
  providers: [AdminMiscController, AdminSessions, AuditService, { provide: APP_GUARD, useClass: AdminGuard }],
})
export class AdminModule {}
