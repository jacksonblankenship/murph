import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Queue } from 'bullmq';
import { ChannelModule } from '../../channels/channel.module';
import { AgentDispatcher } from '../../dispatcher';
import { OutboundCallService } from './outbound-call.service';
import { VoiceGateway } from './voice.gateway';
import { VoiceCallProcessor } from './voice-call.processor';
import { VoiceSessionManager } from './voice-session.manager';
import { VoiceTwimlController } from './voice-twiml.controller';

/**
 * Module for voice call support via Twilio ConversationRelay.
 *
 * Provides:
 * - TwiML webhook controller for call setup
 * - WebSocket gateway for real-time speech-to-text / text-to-speech
 * - Session manager for tracking active calls
 * - Outbound call service for initiating calls
 * - BullMQ processor for scheduled/dispatched calls
 */
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
  controllers: [VoiceTwimlController],
  providers: [
    VoiceGateway,
    VoiceSessionManager,
    OutboundCallService,
    VoiceCallProcessor,
  ],
  exports: [OutboundCallService],
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
