import { Module } from '@nestjs/common';
import { CoachPreferencesController } from './coach-preferences.controller';
import { CoachPreferencesService } from './coach-preferences.service';

/** Coach style and memory (Plus): GET/PUT /coach/preferences; the coach reads them through the exported service. */
@Module({ controllers: [CoachPreferencesController], providers: [CoachPreferencesService], exports: [CoachPreferencesService] })
export class CoachPreferencesModule {}
