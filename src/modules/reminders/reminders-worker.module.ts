import { Module } from '@nestjs/common';
import { pushProvider } from './providers/push.provider';
import { RemindersService } from './reminders.service';

@Module({ providers: [RemindersService, pushProvider] })
export class RemindersWorkerModule {}
