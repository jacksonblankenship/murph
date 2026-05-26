/**
 * Twilio ConversationRelay WebSocket message types.
 *
 * Spec: https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
 *
 * Inbound (server → us) and outbound (us → server) variants are split for
 * clarity. The session/sink layer never sees these — only {@link TwilioGateway}
 * and {@link TwilioOutputSink} touch them.
 */

/** Initial message from Twilio after WS connect. */
export interface TwilioSetupMessage {
  type: 'setup';
  callSid: string;
  sessionId?: string;
  accountSid?: string;
  from: string;
  to: string;
  direction: string;
  customParameters?: Record<string, string>;
}

/** Caller speech, post-STT. */
export interface TwilioPromptMessage {
  type: 'prompt';
  voicePrompt: string;
  /** False for partial transcripts when `speechtimeout` / `partialPrompts` are set. */
  last?: boolean;
  lang?: string;
}

export interface TwilioInterruptMessage {
  type: 'interrupt';
  utteranceUntilInterrupt?: string;
  durationUntilInterruptMs?: number;
}

export interface TwilioDtmfMessage {
  type: 'dtmf';
  digit: string;
}

export interface TwilioErrorMessage {
  type: 'error';
  description?: string;
}

export type TwilioInboundMessage =
  | TwilioSetupMessage
  | TwilioPromptMessage
  | TwilioInterruptMessage
  | TwilioDtmfMessage
  | TwilioErrorMessage
  | { type: string };

/** TTS token frame written back to Twilio. */
export interface TwilioTextOutbound {
  type: 'text';
  token: string;
  last: boolean;
}

/** End-of-session frame. Twilio closes the WS and hangs up. */
export interface TwilioEndOutbound {
  type: 'end';
}

export type TwilioOutboundMessage = TwilioTextOutbound | TwilioEndOutbound;
