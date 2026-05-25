/**
 * An input event flowing from a voice transport into a {@link VoiceCallSession}.
 *
 * The session does not know about specific wire protocols — transports
 * translate their own message shapes into one of these variants.
 */
export type VoiceInputEvent =
  | {
      type: 'transcript';
      /** What the caller said, after STT. */
      text: string;
      /**
       * `true` once the speaker has finished the utterance (e.g. Twilio's
       * `prompt` message with `last: true`). Partial transcripts (`false`)
       * are logged but not sent to the LLM.
       */
      isFinal: boolean;
    }
  | { type: 'interrupt' }
  | { type: 'dtmf'; digit: string };

/**
 * Outbound channel for one voice call. The session pushes events into a
 * sink; each transport supplies an implementation that translates these
 * events into its own wire protocol.
 *
 * Implementations should be cheap to construct (one per call) and must
 * tolerate being called after the underlying connection is gone — they
 * should treat post-close writes as no-ops, not throw.
 */
export interface VoiceOutputSink {
  /**
   * Stream a TTS token to the caller.
   *
   * @param token  Text fragment to speak. Empty string is allowed when
   *               `last` is true (signals end-of-turn with no extra text).
   * @param last   Whether this is the final token in the current turn.
   */
  sendToken(token: string, last: boolean): void;

  /**
   * Signal that the call should end. The transport should close its
   * connection / send any termination message its protocol requires.
   */
  sendEnd(): void;
}

/**
 * Context passed when constructing a {@link VoiceCallSession}.
 *
 * `sessionId` is whatever stable identifier the transport uses (Twilio
 * call SID, Discord voice connection id, etc.) — the session itself does
 * not interpret it beyond using it as a registry key and log field.
 */
export interface VoiceCallSessionContext {
  sessionId: string;
  userId: number;
  /**
   * Optional outbound-call context — for example, "you're calling Jackson
   * to remind him about a meeting." Prepended to the first prompt so the
   * LLM has a reason for the call, then discarded.
   */
  callContext?: string;
}

/**
 * One in-flight voice conversation.
 *
 * Responsibilities:
 * - Convert {@link VoiceInputEvent} into LLM stream invocations
 * - Pump LLM output tokens into the {@link VoiceOutputSink}
 * - Watch for the `hang_up` tool call and signal end after the response
 * - Cancel any in-flight stream on interrupt, close, or new prompt
 */
export interface VoiceCallSession {
  readonly sessionId: string;
  readonly userId: number;
  /**
   * Process an input event from the transport.
   *
   * Returns a promise so the caller can `.catch()` to prevent unhandled
   * rejections — but must never reject for normal control flow (e.g.
   * abort during stream is logged and swallowed).
   */
  handleInput(event: VoiceInputEvent): Promise<void>;
  /**
   * Tear down: abort any in-flight stream and release references.
   * Idempotent — safe to call multiple times.
   */
  close(): void;
}
