import { Module } from '@nestjs/common';
import { ChannelModule } from '../../../channels/channel.module';
import { VoiceSessionRegistry } from './voice-session.registry';

/**
 * Common voice infrastructure shared across voice transport adapters.
 *
 * Exports the session registry and re-exports {@link ChannelModule} so
 * adapter modules can inject {@link ChannelOrchestratorService} when
 * constructing per-call sessions.
 */
@Module({
  imports: [ChannelModule],
  providers: [VoiceSessionRegistry],
  exports: [VoiceSessionRegistry, ChannelModule],
})
export class VoiceSessionModule {}
