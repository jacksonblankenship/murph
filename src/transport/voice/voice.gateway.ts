import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { PinoLogger } from 'nestjs-pino';
import type { WebSocket } from 'ws';
import { ChannelOrchestratorService } from '../../channels/channel-orchestrator.service';
import { VOICE_CHANNEL_ID } from '../../channels/presets/voice.preset';
import { VoiceSessionManager } from './voice-session.manager';

/** Delay in ms before sending end message, lets Twilio finish speaking. */
const HANG_UP_DELAY_MS = 500;

/**
 * ConversationRelay message types sent by Twilio.
 */
interface SetupMessage {
  type: 'setup';
  callSid: string;
  from: string;
  to: string;
  direction: string;
  customParameters?: Record<string, string>;
}

interface PromptMessage {
  type: 'prompt';
  voicePrompt: string;
}

interface InterruptMessage {
  type: 'interrupt';
}

interface DtmfMessage {
  type: 'dtmf';
  digit: string;
}

type TwilioMessage =
  | SetupMessage
  | PromptMessage
  | InterruptMessage
  | DtmfMessage
  | { type: string };

/**
 * WebSocket gateway for Twilio ConversationRelay.
 *
 * Handles the WebSocket connection lifecycle:
 * 1. Twilio connects after receiving TwiML from {@link VoiceTwimlController}
 * 2. Receives `setup` message with call metadata
 * 3. Receives `prompt` messages with transcribed speech
 * 4. Streams LLM responses back as `text` messages for TTS
 * 5. Handles `interrupt` (barge-in) by aborting the current stream
 * 6. Sends `end` message when the call should terminate
 */
@WebSocketGateway({ path: '/voice/ws' })
export class VoiceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly userId: number;

  constructor(
    private readonly logger: PinoLogger,
    private readonly configService: ConfigService,
    private readonly sessionManager: VoiceSessionManager,
    private readonly channelOrchestrator: ChannelOrchestratorService,
  ) {
    this.logger.setContext(VoiceGateway.name);
    this.userId = this.configService.get<number>('voice.userId');
  }

  /**
   * Called when Twilio opens the WebSocket connection.
   * Registers a raw message handler to dispatch on message type.
   */
  handleConnection(client: WebSocket): void {
    this.logger.info('Voice WebSocket connected');

    client.on('message', (data: Buffer | string) => {
      try {
        const message: TwilioMessage = JSON.parse(
          typeof data === 'string' ? data : data.toString(),
        );
        this.dispatchMessage(client, message);
      } catch (error) {
        this.logger.error({ err: error }, 'Failed to parse WebSocket message');
      }
    });
  }

  /**
   * Called when the WebSocket connection closes.
   * Cleans up the session and aborts any in-progress stream.
   */
  handleDisconnect(client: WebSocket): void {
    const session = this.sessionManager.getByClient(client);
    if (session) {
      this.logger.info({ callSid: session.callSid }, 'Voice call disconnected');
    }
    this.sessionManager.remove(client);
  }

  /**
   * Routes incoming messages to the appropriate handler.
   */
  private dispatchMessage(client: WebSocket, message: TwilioMessage): void {
    switch (message.type) {
      case 'setup':
        this.handleSetup(client, message as SetupMessage);
        break;
      case 'prompt':
        this.handlePrompt(client, message as PromptMessage);
        break;
      case 'interrupt':
        this.handleInterrupt(client);
        break;
      case 'dtmf':
        this.logger.debug(
          { digit: (message as DtmfMessage).digit },
          'DTMF received',
        );
        break;
      case 'error':
        this.logger.error({ message }, 'Twilio ConversationRelay error');
        break;
      default:
        this.logger.debug({ type: message.type }, 'Unhandled message type');
    }
  }

  /**
   * Handles the `setup` message — creates a session for the call.
   */
  private handleSetup(client: WebSocket, message: SetupMessage): void {
    const callContext = message.customParameters?.callContext;

    this.logger.info(
      {
        callSid: message.callSid,
        from: message.from,
        to: message.to,
        direction: message.direction,
        hasContext: !!callContext,
      },
      'Voice call setup',
    );

    this.sessionManager.create(
      message.callSid,
      this.userId,
      client,
      callContext,
    );
  }

  /**
   * Handles a `prompt` message — transcribed speech from the caller.
   *
   * Streams the LLM response back to Twilio as `text` messages.
   * Watches for `hang_up` tool calls to end the call after the response.
   */
  private async handlePrompt(
    client: WebSocket,
    message: PromptMessage,
  ): Promise<void> {
    const session = this.sessionManager.getByClient(client);
    if (!session) {
      this.logger.warn('Prompt received without active session');
      return;
    }

    // Abort any previous stream
    if (session.abortController) {
      session.abortController.abort();
    }

    const abortController = new AbortController();
    session.abortController = abortController;
    session.shouldHangUp = false;

    const userMessage = session.callContext
      ? `${message.voicePrompt}\n\n[Call context: ${session.callContext}]`
      : message.voicePrompt;

    // Clear call context after first prompt (only needed for initial greeting)
    session.callContext = undefined;

    this.logger.debug(
      { callSid: session.callSid, prompt: message.voicePrompt },
      'Processing voice prompt',
    );

    try {
      const stream = this.channelOrchestrator.executeStreaming(
        VOICE_CHANNEL_ID,
        {
          message: userMessage,
          userId: session.userId,
        },
        { abortSignal: abortController.signal },
      );

      for await (const event of stream) {
        // Stop if connection closed or aborted
        if (abortController.signal.aborted) break;

        switch (event.type) {
          case 'text-delta':
            this.sendToTwilio(client, {
              type: 'text',
              token: event.delta,
              last: false,
            });
            break;

          case 'tool-call':
            if (event.toolName === 'hang_up') {
              session.shouldHangUp = true;
            }
            break;

          case 'finish':
            this.sendToTwilio(client, {
              type: 'text',
              token: '',
              last: true,
            });

            if (session.shouldHangUp) {
              // Small delay to let Twilio finish speaking
              setTimeout(() => {
                this.sendToTwilio(client, { type: 'end' });
              }, HANG_UP_DELAY_MS);
            }
            break;
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        this.logger.debug({ callSid: session.callSid }, 'Voice stream aborted');
        return;
      }
      this.logger.error(
        { err: error, callSid: session.callSid },
        'Error processing voice prompt',
      );
    }
  }

  /**
   * Handles an `interrupt` message — caller started speaking mid-response.
   * Aborts the current LLM stream.
   */
  private handleInterrupt(client: WebSocket): void {
    const session = this.sessionManager.getByClient(client);
    if (!session) return;

    this.logger.debug({ callSid: session.callSid }, 'Voice stream interrupted');

    if (session.abortController) {
      session.abortController.abort();
      session.abortController = undefined;
    }
  }

  /**
   * Sends a JSON message to Twilio via the WebSocket.
   */
  private sendToTwilio(client: WebSocket, message: object): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(message));
    }
  }
}
