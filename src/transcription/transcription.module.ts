import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TranscriptionService } from './transcription.service';

/**
 * Module providing audio transcription via ElevenLabs Scribe v2.
 */
@Module({
  imports: [ConfigModule],
  providers: [TranscriptionService],
  exports: [TranscriptionService],
})
export class TranscriptionModule {}
