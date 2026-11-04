import { Module } from '@nestjs/common';
import { AccountService } from './account.service';
import { DevicesController } from './controllers/devices.controller';
import { ExportController } from './controllers/export.controller';

@Module({ controllers: [DevicesController, ExportController], providers: [AccountService], exports: [AccountService] })
export class AccountModule {}
