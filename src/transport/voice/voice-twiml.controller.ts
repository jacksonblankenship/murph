import { join } from 'node:path';
import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import twilio from 'twilio';
import type VoiceResponse from 'twilio/lib/twiml/VoiceResponse';
import { AgentDispatcher } from '../../dispatcher';
import { TwilioSignatureGuard } from './twilio-signature.guard';

/** Call statuses that indicate the call never connected to the user. */
const TERMINAL_FAILURE_STATUSES = new Set([
  'failed',
  'busy',
  'no-answer',
  'canceled',
]);

/**
 * Controller that returns TwiML to Twilio for voice call setup.
 *
 * Called by Twilio when:
 * - An inbound call arrives at our Twilio number
 * - An outbound call is initiated via `OutboundCallService`
 *
 * Returns TwiML that instructs Twilio to open a ConversationRelay
 * WebSocket connection back to our voice gateway.
 */
@Controller('voice')
export class VoiceTwimlController {
  private readonly serverUrl: string;

  constructor(
    private readonly logger: PinoLogger,
    private readonly configService: ConfigService,
    private readonly dispatcher: AgentDispatcher,
  ) {
    this.logger.setContext(VoiceTwimlController.name);
    this.serverUrl = this.configService.get<string>('voice.serverUrl');
  }

  /**
   * Returns TwiML for ConversationRelay setup.
   *
   * For inbound calls: includes `welcomeGreeting` so Murph greets the caller.
   * For outbound calls: no greeting (Jackson answers "Hello?"), includes
   * call context as a custom parameter.
   *
   * @param context - Optional call context for outbound calls
   */
  @Post('twiml')
  @Header('Content-Type', 'text/xml')
  @UseGuards(TwilioSignatureGuard)
  handleTwiml(@Query('context') context?: string): string {
    const response = new twilio.twiml.VoiceResponse();
    const connect = response.connect();

    const isOutbound = !!context;
    const wsUrl = `${this.serverUrl.replace(/^http/, 'ws')}/voice/ws`;

    const relayAttrs: VoiceResponse.ConversationRelayAttributes = {
      url: wsUrl,
      ttsProvider: 'ElevenLabs',
      voice: 'yM93hbw8Qtvdma2wCnJG',
      transcriptionProvider: 'Deepgram',
      speechModel: 'nova-3-general',
      interruptible: 'any',
      interruptSensitivity: 'medium',
      dtmfDetection: true,
      // ms of silence before Twilio reports the final prompt (600–5000).
      // Lower than the default `auto` to reduce end-of-turn latency.
      speechtimeout: '1500',
      // Stops "yeah"/"uh-huh" backchannels from interrupting Murph mid-sentence.
      ignorebackchannel: 'true',
      // Tokens-played + speaker-events let us track playback state if we ever
      // need richer barge-in handling.
      events: 'speaker-events tokens-played',
    };

    if (!isOutbound) {
      relayAttrs.welcomeGreeting = 'Hey!';
      relayAttrs.welcomeGreetingInterruptible = 'speech';
    }

    const relay = connect.conversationRelay(relayAttrs);

    if (isOutbound) {
      relay.parameter({ name: 'callContext', value: context });
    }

    return response.toString();
  }

  /**
   * Receives Twilio call status callback events.
   *
   * Logs call progress for visibility. On terminal failures (`failed`,
   * `busy`, `no-answer`, `canceled`), dispatches to the `scheduled-messages`
   * queue so Murph can compose a natural fallback message via text.
   *
   * @param userId - Telegram user ID, passed as query param from OutboundCallService
   * @param context - Original call context, passed as query param from OutboundCallService
   * @param body - Twilio status callback POST body
   */
  @Post('status')
  @UseGuards(TwilioSignatureGuard)
  handleStatus(
    @Query('userId') userId?: string,
    @Query('context') context?: string,
    @Body()
    body?: {
      CallSid?: string;
      CallStatus?: string;
      ErrorCode?: string;
      SipResponseCode?: string;
      Duration?: string;
    },
  ): void {
    this.logger.info(
      {
        callSid: body?.CallSid,
        callStatus: body?.CallStatus,
        errorCode: body?.ErrorCode,
        sipResponseCode: body?.SipResponseCode,
        duration: body?.Duration,
      },
      'Call status update',
    );

    const isTerminalFailure = TERMINAL_FAILURE_STATUSES.has(
      body?.CallStatus ?? '',
    );
    if (!isTerminalFailure || !userId) {
      return;
    }

    const callSid = body?.CallSid ?? 'unknown';
    const callStatus = body?.CallStatus ?? 'unknown';

    this.logger.warn(
      { callSid, callStatus },
      'Call failed, dispatching fallback message',
    );

    const prompt = context
      ? `Your outbound voice call failed (status: ${callStatus}). You were calling because: ${context}. Let them know via message instead.`
      : `Your outbound voice call failed (status: ${callStatus}). Let them know you tried to reach them.`;

    this.dispatcher.dispatch({
      queue: 'scheduled-messages',
      jobName: 'process-scheduled-message',
      data: {
        userId: Number(userId),
        content: prompt,
        taskId: `call-fallback-${callSid}`,
        timestamp: Date.now(),
      },
    });
  }

  /**
   * Serves the pre-recorded fallback audio file.
   *
   * Used by the TwiML fallback endpoint to play Murph's voice when
   * the primary handler is unavailable.
   */
  @Get('assets/fallback.mp3')
  @Header('Content-Type', 'audio/mpeg')
  serveFallbackAudio(@Res() res: Response): void {
    const filePath = join(__dirname, 'assets', 'fallback.mp3');
    res.sendFile(filePath);
  }

  /**
   * TwiML fallback handler for when the primary `/voice/twiml` endpoint fails.
   *
   * Configured as Twilio's "Primary handler fails" webhook. Returns TwiML
   * that plays a pre-recorded message in Murph's voice so the caller hears
   * a graceful degradation instead of silence.
   */
  @Post('twiml/fallback')
  @Header('Content-Type', 'text/xml')
  @UseGuards(TwilioSignatureGuard)
  handleTwimlFallback(): string {
    this.logger.warn('Primary TwiML handler failed, serving fallback');
    const response = new twilio.twiml.VoiceResponse();
    response.play(`${this.serverUrl}/voice/assets/fallback.mp3`);
    return response.toString();
  }
}
