import { Module } from '@nestjs/common';
import { AccountService } from './account.service';

/** Worker role: export and purge handlers. */
@Module({ providers: [AccountService] })
export class AccountWorkerModule {}
