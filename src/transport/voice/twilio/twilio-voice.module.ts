import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AgentDispatcher } from '../../../dispatcher';
import { VoiceSessionModule } from '../common/voice-session.module';
import { TwilioGateway } from './twilio.gateway';
import { TwilioCallProcessor } from './twilio-call.processor';
import { TwilioOutboundService } from './twilio-outbound.service';
import { TwilioSignatureGuard } from './twilio-signature.guard';
import { TwilioTwimlController } from './twilio-twiml.controller';

/**
 * Twilio-specific voice transport.
 *
 * Provides the WS gateway, TwiML controller, outbound REST client, and
 * the BullMQ processor that consumes the `voice-calls` queue. Depends
 * on {@link VoiceSessionModule} for the per-call session registry.
 *
 * Adding another voice transport (Discord voice, etc.) means creating
 * a sibling module that also imports {@link VoiceSessionModule}.
 */
@Module({
  imports: [
    ConfigModule,
    VoiceSessionModule,
    BullModule.registerQueue({
      name: 'voice-calls',
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
      },
    }),
  ],
  controllers: [TwilioTwimlController],
  providers: [
    TwilioGateway,
    TwilioOutboundService,
    TwilioCallProcessor,
    TwilioSignatureGuard,
  ],
  exports: [TwilioOutboundService],
})
export class TwilioVoiceModule implements OnModuleInit {
  constructor(
    private readonly dispatcher: AgentDispatcher,
    @InjectQueue('voice-calls') private readonly voiceCallsQueue: Queue,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerQueue('voice-calls', this.voiceCallsQueue);
  }
}
