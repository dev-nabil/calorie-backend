import { Module } from '@nestjs/common';
import { pushProvider } from './providers/push.provider';
import { PushSender } from './providers/push';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';

@Module({ controllers: [RemindersController], providers: [RemindersService, pushProvider], exports: [RemindersService, PushSender] })
export class RemindersModule {}
