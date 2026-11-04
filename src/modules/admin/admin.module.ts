import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminAuthController } from './controllers/admin-auth.controller';
import { AdminContentController } from './controllers/admin-content.controller';
import { AdminMiscController } from './controllers/admin-misc.controller';
import { AdminUsersController } from './controllers/admin-users.controller';
import { AdminBillingController } from './controllers/admin-billing.controller';
import { AdminAiController } from './controllers/admin-ai.controller';
import { AdminTeamController } from './controllers/admin-team.controller';
import { BillingModule } from '../billing/billing.module';
import { AdminGuard } from './security/admin.guard';
import { AdminSessions } from './services/admin-sessions.service';
import { AuditService } from './services/audit.service';

/** /v1/admin/* (M7 endpoints): session cookie + TOTP, CSRF, server-side roles, audit log. */
@Module({
  imports: [BillingModule],
  controllers: [AdminAuthController, AdminUsersController, AdminContentController, AdminMiscController, AdminBillingController, AdminAiController, AdminTeamController],
  providers: [AdminMiscController, AdminSessions, AuditService, { provide: APP_GUARD, useClass: AdminGuard }],
})
export class AdminModule {}
