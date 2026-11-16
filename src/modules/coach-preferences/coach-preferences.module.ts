import { Module } from '@nestjs/common';
import { CoachMemoryController } from './coach-memory.controller';
import { CoachMemoryService } from './coach-memory.service';
import { CoachPreferencesController } from './coach-preferences.controller';
import { CoachPreferencesService } from './coach-preferences.service';

/** Coach style and memory: GET/PUT /coach/preferences (Plus) and "What Milo knows about me" (/coach/memory). */
@Module({ controllers: [CoachPreferencesController, CoachMemoryController], providers: [CoachPreferencesService, CoachMemoryService], exports: [CoachPreferencesService, CoachMemoryService] })
export class CoachPreferencesModule {}
