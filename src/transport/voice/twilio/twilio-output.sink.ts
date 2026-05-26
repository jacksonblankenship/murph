import type { WebSocket } from 'ws';
import type { VoiceOutputSink } from '../common/voice-session.types';
import type { TwilioOutboundMessage } from './twilio-message.types';

/**
 * {@link VoiceOutputSink} implementation for Twilio ConversationRelay.
 *
 * Owns one WebSocket and translates session-level output events into the
 * Twilio JSON wire format. Writes are no-ops when the socket is not OPEN
 * so a session that finishes after the caller hangs up doesn't blow up.
 *
 * Constructed per call by {@link TwilioGateway} on the `setup` message.
 */
export class TwilioOutputSink implements VoiceOutputSink {
  constructor(private readonly socket: WebSocket) {}

  sendToken(token: string, isLast: boolean): void {
    this.send({ type: 'text', token, last: isLast });
  }

  sendEnd(): void {
    this.send({ type: 'end' });
  }

  private send(message: TwilioOutboundMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }
}
