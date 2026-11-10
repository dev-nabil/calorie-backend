import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service';

/** Admin settings (registry in settings.registry.ts), available everywhere. */
@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
