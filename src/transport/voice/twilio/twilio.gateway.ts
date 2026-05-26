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
import { ChannelOrchestratorService } from '../../../channels/channel-orchestrator.service';
import { VoiceCallSessionImpl } from '../common/voice-call-session';
import { VoiceSessionRegistry } from '../common/voice-session.registry';
import type {
  VoiceCallSession,
  VoiceInputEvent,
} from '../common/voice-session.types';
import type {
  TwilioDtmfMessage,
  TwilioInboundMessage,
  TwilioPromptMessage,
  TwilioSetupMessage,
} from './twilio-message.types';
import { TwilioOutputSink } from './twilio-output.sink';

/** WebSocket close code 1008 (RFC 6455) — message violates server policy. */
const WS_CLOSE_POLICY_VIOLATION = 1008;

/**
 * Twilio-specific WebSocket gateway for ConversationRelay.
 *
 * Responsibilities (Twilio-specific only):
 * - Validate `X-Twilio-Signature` on the WS upgrade
 * - Parse the ConversationRelay JSON message envelope
 * - On `setup`: create a {@link VoiceCallSessionImpl}, register it
 * - On `prompt` / `interrupt` / `dtmf`: forward as {@link VoiceInputEvent}
 * - On disconnect: remove the session from the registry
 *
 * All conversational lifecycle (LLM streaming, abort, hang-up timing)
 * lives in {@link VoiceCallSessionImpl}, not here.
 */
@WebSocketGateway({ path: '/voice/ws' })
export class TwilioGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly userId: number;
  private readonly authToken: string;
  private readonly wsUrl: string;
  /** WS client → sessionId mapping for disconnect cleanup. */
  private readonly clientToSessionId = new WeakMap<WebSocket, string>();

  constructor(
    private readonly logger: PinoLogger,
    private readonly configService: ConfigService,
    private readonly registry: VoiceSessionRegistry,
    private readonly channelOrchestrator: ChannelOrchestratorService,
  ) {
    this.logger.setContext(TwilioGateway.name);
    this.userId = this.configService.get<number>('voice.userId');
    this.authToken = this.configService.get<string>('twilio.authToken');
    const serverUrl = this.configService.get<string>('voice.serverUrl') ?? '';
    this.wsUrl = `${serverUrl.replace(/^http/, 'ws')}/voice/ws`;
  }

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
        const message = JSON.parse(
          typeof data === 'string' ? data : data.toString(),
        ) as TwilioInboundMessage;
        this.dispatch(client, message);
      } catch (error) {
        this.logger.error({ err: error }, 'Failed to parse WebSocket message');
      }
    });
  }

  handleDisconnect(client: WebSocket): void {
    const sessionId = this.clientToSessionId.get(client);
    if (sessionId) {
      this.logger.info({ sessionId }, 'Voice call disconnected');
      this.registry.remove(sessionId);
      this.clientToSessionId.delete(client);
    }
  }

  /**
   * Routes incoming Twilio messages. Async handler calls are .catch()-ed
   * so a rejection cannot escape into Node's uncaught-rejection path.
   */
  private dispatch(client: WebSocket, message: TwilioInboundMessage): void {
    switch (message.type) {
      case 'setup':
        this.onSetup(client, message as TwilioSetupMessage);
        return;
      case 'prompt': {
        const m = message as TwilioPromptMessage;
        this.forwardToSession(client, {
          type: 'transcript',
          text: m.voicePrompt,
          // Treat missing `last` as `true` for safety — older protocol versions
          // omit it and we'd rather process than silently drop.
          isFinal: m.last !== false,
        });
        return;
      }
      case 'interrupt':
        this.forwardToSession(client, { type: 'interrupt' });
        return;
      case 'dtmf':
        this.forwardToSession(client, {
          type: 'dtmf',
          digit: (message as TwilioDtmfMessage).digit,
        });
        return;
      case 'error':
        this.logger.error({ message }, 'Twilio ConversationRelay error');
        return;
      default:
        this.logger.debug({ type: message.type }, 'Unhandled message type');
    }
  }

  private onSetup(client: WebSocket, message: TwilioSetupMessage): void {
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
    const sink = new TwilioOutputSink(client);
    const session: VoiceCallSession = new VoiceCallSessionImpl(
      this.logger,
      this.channelOrchestrator,
      sink,
      { sessionId: message.callSid, userId: this.userId, callContext },
    );
    this.registry.register(session);
    this.clientToSessionId.set(client, message.callSid);
  }

  private forwardToSession(client: WebSocket, event: VoiceInputEvent): void {
    const sessionId = this.clientToSessionId.get(client);
    if (!sessionId) {
      this.logger.warn(
        { eventType: event.type },
        'Input before setup, dropping',
      );
      return;
    }
    const session = this.registry.get(sessionId);
    if (!session) {
      this.logger.warn({ sessionId }, 'Session missing in registry');
      return;
    }
    session.handleInput(event).catch(err => {
      this.logger.error({ err, sessionId }, 'session.handleInput rejected');
    });
  }

  /**
   * Validates the `X-Twilio-Signature` header on the WS upgrade request.
   * Returns true if validation is disabled (no authToken — dev fallback).
   */
  private verifySignature(request?: IncomingMessage): boolean {
    if (!this.authToken) {
      this.logger.warn(
        'TWILIO_AUTH_TOKEN not set — accepting WS handshake without signature validation',
      );
      return true;
    }
    if (!request) return false;
    const signature = request.headers['x-twilio-signature'];
    const value = Array.isArray(signature) ? signature[0] : signature;
    if (!value) return false;
    return validateRequest(this.authToken, value, this.wsUrl, {});
  }
}
