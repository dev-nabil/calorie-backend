import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RemindersModule } from '../reminders/reminders.module';
import { DevController } from './dev.controller';

@Module({ imports: [AuthModule, RemindersModule], controllers: [DevController] })
export class DevModule {}
