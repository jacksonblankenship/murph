import type { IncomingMessage } from 'node:http';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { PinoLogger } from 'nestjs-pino';
import { validateRequest } from 'twilio';
import type { WebSocket } from 'ws';
import { ChannelOrchestratorService } from '../../channels/channel-orchestrator.service';
import { VOICE_CHANNEL_ID } from '../../channels/presets/voice.preset';
import { VoiceSessionManager } from './voice-session.manager';

/** Delay in ms before sending end message, lets Twilio finish speaking. */
const HANG_UP_DELAY_MS = 500;

/** WebSocket close code 1008 (RFC 6455) — message violates server policy. */
const WS_CLOSE_POLICY_VIOLATION = 1008;

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
  /**
   * False when Twilio sends a partial prompt (e.g. with `speechtimeout` or
   * `partialPrompts` enabled). We only process the final transcript so the
   * LLM isn't invoked mid-utterance.
   */
  last?: boolean;
  lang?: string;
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
  private readonly authToken: string;
  private readonly wsUrl: string;

  constructor(
    private readonly logger: PinoLogger,
    private readonly configService: ConfigService,
    private readonly sessionManager: VoiceSessionManager,
    private readonly channelOrchestrator: ChannelOrchestratorService,
  ) {
    this.logger.setContext(VoiceGateway.name);
    this.userId = this.configService.get<number>('voice.userId');
    this.authToken = this.configService.get<string>('twilio.authToken');
    const serverUrl = this.configService.get<string>('voice.serverUrl') ?? '';
    this.wsUrl = `${serverUrl.replace(/^http/, 'ws')}/voice/ws`;
  }

  /**
   * Called when Twilio opens the WebSocket connection.
   *
   * Validates the `X-Twilio-Signature` header on the handshake before
   * accepting the session. Twilio signs the WSS URL (no body) with
   * HMAC-SHA1(authToken), per ConversationRelay's signature-header feature.
   *
   * @see https://www.twilio.com/en-us/changelog/new-features-now-available-for-conversationrelay
   */
  handleConnection(client: WebSocket, request?: IncomingMessage): void {
    if (!this.verifySignature(request)) {
      this.logger.warn(
        { ip: request?.socket?.remoteAddress },
        'Rejected WebSocket handshake with invalid Twilio signature',
      );
      client.close(WS_CLOSE_POLICY_VIOLATION, 'Invalid Twilio signature');
      return;
    }

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
   *
   * Skips partial prompts (`last !== true`). With `speechtimeout` set on
   * the relay, Twilio may emit interim transcripts as the caller speaks;
   * acting on those would fire the LLM mid-utterance.
   */
  private async handlePrompt(
    client: WebSocket,
    message: PromptMessage,
  ): Promise<void> {
    // Default `last` to `true` for safety: if Twilio ever omits the field
    // (older protocol, edge cases), treat the prompt as final rather than
    // silently dropping it.
    if (message.last === false) {
      this.logger.debug(
        { prompt: message.voicePrompt },
        'Skipping partial prompt',
      );
      return;
    }

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

  /**
   * Validates the `X-Twilio-Signature` header on the WS upgrade request.
   *
   * Returns `true` if validation is disabled (no `authToken` configured —
   * intended for local-only flows; production must set TWILIO_AUTH_TOKEN).
   * Returns `false` if the header is missing or HMAC validation fails.
   */
  private verifySignature(request?: IncomingMessage): boolean {
    if (!this.authToken) {
      this.logger.warn(
        'TWILIO_AUTH_TOKEN not set — accepting WS handshake without signature validation',
      );
      return true;
    }
    if (!request) {
      return false;
    }
    const signature = request.headers['x-twilio-signature'];
    const signatureValue = Array.isArray(signature) ? signature[0] : signature;
    if (!signatureValue) {
      return false;
    }
    return validateRequest(this.authToken, signatureValue, this.wsUrl, {});
  }
}
