import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Queue } from 'bullmq';
import { ChannelModule } from '../../channels/channel.module';
import { AgentDispatcher } from '../../dispatcher';
import { VoiceSessionRegistry } from './common/voice-session.registry';
import { TwilioGateway } from './twilio/twilio.gateway';
import { TwilioCallProcessor } from './twilio/twilio-call.processor';
import { TwilioOutboundService } from './twilio/twilio-outbound.service';
import { TwilioSignatureGuard } from './twilio/twilio-signature.guard';
import { TwilioTwimlController } from './twilio/twilio-twiml.controller';

@Module({
  imports: [
    ConfigModule,
    ChannelModule,
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
    VoiceSessionRegistry,
    TwilioOutboundService,
    TwilioCallProcessor,
    TwilioSignatureGuard,
  ],
  exports: [TwilioOutboundService],
})
export class VoiceModule implements OnModuleInit {
  constructor(
    private readonly dispatcher: AgentDispatcher,
    @InjectQueue('voice-calls') private readonly voiceCallsQueue: Queue,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerQueue('voice-calls', this.voiceCallsQueue);
  }
}
