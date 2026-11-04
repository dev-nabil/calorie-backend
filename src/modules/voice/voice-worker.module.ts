import { Module } from '@nestjs/common';
import { VoiceService } from './voice.service';

@Module({ providers: [VoiceService] })
export class VoiceWorkerModule {}
