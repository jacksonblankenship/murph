import { Module } from '@nestjs/common';
import { VoiceSessionModule } from './common/voice-session.module';
import { TwilioVoiceModule } from './twilio/twilio-voice.module';

/**
 * Umbrella module that bundles every voice transport.
 *
 * Currently provides Twilio only. To add another voice transport, declare
 * a sibling module under `transport/voice/<name>/` and import it here.
 *
 * Re-exports {@link TwilioVoiceModule} so consumers (e.g. `AppModule`) get
 * full access to Twilio's exports, including `TwilioOutboundService`.
 */
@Module({
  imports: [VoiceSessionModule, TwilioVoiceModule],
  exports: [TwilioVoiceModule],
})
export class VoiceModule {}
