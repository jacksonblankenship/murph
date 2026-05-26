import { PinoLogger } from 'nestjs-pino';
import type { ChannelOrchestratorService } from '../../../channels/channel-orchestrator.service';
import { VOICE_CHANNEL_ID } from '../../../channels/presets/voice.preset';
import type {
  VoiceCallSession,
  VoiceCallSessionContext,
  VoiceInputEvent,
  VoiceOutputSink,
} from './voice-session.types';

/** Delay in ms before sending end after hang_up — lets Twilio finish speaking. */
const HANG_UP_DELAY_MS = 500;

/**
 * Transport-agnostic per-call session.
 *
 * Owns the LLM stream lifecycle for one voice call:
 * - Receives input events from a transport (transcript / interrupt / dtmf)
 * - Invokes the LLM via {@link ChannelOrchestratorService.executeStreaming}
 * - Pumps tokens into the injected {@link VoiceOutputSink}
 * - Watches for the `hang_up` tool call and signals end via the sink
 * - Cancels any in-flight stream when a new prompt arrives, on interrupt,
 *   or on {@link close}
 *
 * Construct one per call. The transport's gateway is responsible for
 * choosing when to instantiate (e.g. on a Twilio `setup` message).
 */
export class VoiceCallSessionImpl implements VoiceCallSession {
  readonly sessionId: string;
  readonly userId: number;

  private currentAbort: AbortController | undefined;
  private hangUpTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private shouldHangUp = false;
  private pendingCallContext: string | undefined;
  private closed = false;

  constructor(
    private readonly logger: PinoLogger,
    private readonly channelOrchestrator: ChannelOrchestratorService,
    private readonly sink: VoiceOutputSink,
    context: VoiceCallSessionContext,
  ) {
    this.logger.setContext(VoiceCallSessionImpl.name);
    this.sessionId = context.sessionId;
    this.userId = context.userId;
    this.pendingCallContext = context.callContext;
  }

  /**
   * @see VoiceCallSession.handleInput
   *
   * Asymmetric resolve: awaits when no stream is in flight (caller sees
   * completion); fire-and-forgets when superseding an in-flight stream
   * (caller is not blocked, errors are still logged internally).
   */
  async handleInput(event: VoiceInputEvent): Promise<void> {
    if (this.closed) {
      this.logger.debug(
        { sessionId: this.sessionId },
        'Ignoring input on closed session',
      );
      return;
    }
    switch (event.type) {
      case 'transcript': {
        const inflightAbort = this.currentAbort;
        if (inflightAbort) {
          // A stream is already running — abort it and fire-and-forget the new
          // one so the caller is not blocked waiting for an infinite generator.
          // The new stream runs independently in the background.
          this.safeAbort(inflightAbort);
          void this.onTranscript(event.text, event.isFinal);
        } else {
          // No stream in flight — await the new stream so the caller can
          // detect completion (useful for short-lived streams in tests and
          // for ensuring tokens are delivered before returning).
          await this.onTranscript(event.text, event.isFinal);
        }
        return;
      }
      case 'interrupt':
        this.onInterrupt();
        return;
      case 'dtmf':
        this.logger.debug(
          { sessionId: this.sessionId, digit: event.digit },
          'DTMF received',
        );
        return;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelHangUpTimer();
    if (this.currentAbort) {
      this.safeAbort(this.currentAbort);
      this.currentAbort = undefined;
    }
    this.logger.info({ sessionId: this.sessionId }, 'Voice session closed');
  }

  private async onTranscript(text: string, isFinal: boolean): Promise<void> {
    if (!isFinal) {
      this.logger.debug(
        { sessionId: this.sessionId, text },
        'Skipping partial transcript',
      );
      return;
    }

    // Cancel any in-flight stream from a previous prompt, plus any pending
    // hang-up timer from a prior turn (the user spoke again before we
    // could end the call — don't end it now).
    if (this.currentAbort) this.safeAbort(this.currentAbort);
    this.cancelHangUpTimer();

    const abort = new AbortController();
    this.currentAbort = abort;
    this.shouldHangUp = false;

    const userMessage = this.pendingCallContext
      ? `${text}\n\n[Call context: ${this.pendingCallContext}]`
      : text;
    this.pendingCallContext = undefined;

    this.logger.debug(
      { sessionId: this.sessionId, text },
      'Processing transcript',
    );

    const abortPromise = new Promise<never>((_, reject) => {
      abort.signal.addEventListener(
        'abort',
        () =>
          reject(
            Object.assign(new Error('AbortError'), { name: 'AbortError' }),
          ),
        { once: true },
      );
    });

    try {
      const stream = this.channelOrchestrator.executeStreaming(
        VOICE_CHANNEL_ID,
        { message: userMessage, userId: this.userId },
        { abortSignal: abort.signal },
      );

      while (true) {
        const result = await Promise.race([stream.next(), abortPromise]);
        if (result.done) break;
        const event = result.value;
        switch (event.type) {
          case 'text-delta':
            this.sink.sendToken(event.delta, false);
            break;
          case 'tool-call':
            if (event.toolName === 'hang_up') this.shouldHangUp = true;
            break;
          case 'finish':
            this.sink.sendToken('', true);
            if (this.shouldHangUp) {
              this.cancelHangUpTimer();
              this.hangUpTimeoutId = setTimeout(() => {
                this.hangUpTimeoutId = undefined;
                this.sink.sendEnd();
              }, HANG_UP_DELAY_MS);
            }
            break;
        }
      }
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') {
        this.logger.debug(
          { sessionId: this.sessionId },
          'Voice stream aborted',
        );
        return;
      }
      this.logger.error(
        { err: error, sessionId: this.sessionId },
        'Error processing transcript',
      );
    } finally {
      if (this.currentAbort === abort) this.currentAbort = undefined;
    }
  }

  private onInterrupt(): void {
    this.logger.debug(
      { sessionId: this.sessionId },
      'Voice stream interrupted',
    );
    this.cancelHangUpTimer();
    if (this.currentAbort) {
      this.safeAbort(this.currentAbort);
      this.currentAbort = undefined;
    }
  }

  /**
   * Clear any pending hang-up `setTimeout`. Idempotent — safe to call
   * when no timer is scheduled.
   */
  private cancelHangUpTimer(): void {
    if (this.hangUpTimeoutId !== undefined) {
      clearTimeout(this.hangUpTimeoutId);
      this.hangUpTimeoutId = undefined;
    }
  }

  /**
   * Calls `controller.abort()` and swallows any synchronous throw.
   * Under Bun, AbortSignal listeners can throw re-entrantly; we only need
   * the signal to flip and never care about the listener's return value.
   */
  private safeAbort(controller: AbortController): void {
    try {
      controller.abort();
    } catch (err) {
      this.logger.debug({ err }, 'AbortController.abort() threw');
    }
  }
}
