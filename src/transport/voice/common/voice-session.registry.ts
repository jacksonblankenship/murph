import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { VoiceCallSession } from './voice-session.types';

/**
 * In-memory registry of active voice call sessions, keyed by session id.
 *
 * Transports register a session on inbound connection setup and remove it
 * when the connection closes. {@link remove} also calls
 * {@link VoiceCallSession.close} so callers don't have to do that twice.
 */
@Injectable()
export class VoiceSessionRegistry {
  private readonly sessions = new Map<string, VoiceCallSession>();

  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(VoiceSessionRegistry.name);
  }

  /**
   * Register a new session. If a different session with the same id is
   * already registered, it is closed and replaced — this handles
   * transport-level reconnects where the old session must release its
   * resources. Callers should pass a freshly constructed session object,
   * not re-register an existing instance (doing so would close the live
   * session before replacing it with itself).
   */
  register(session: VoiceCallSession): void {
    const existing = this.sessions.get(session.sessionId);
    if (existing) {
      this.logger.warn(
        { sessionId: session.sessionId },
        'Replacing existing session for id',
      );
      existing.close();
    }
    this.sessions.set(session.sessionId, session);
    this.logger.info(
      { sessionId: session.sessionId, userId: session.userId },
      'Voice session registered',
    );
  }

  /**
   * Retrieve the active session for the given id, or `undefined` if not found.
   */
  get(sessionId: string): VoiceCallSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Remove and close the session for the given id. No-op if not registered.
   */
  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.close();
    this.sessions.delete(sessionId);
    this.logger.info({ sessionId }, 'Voice session removed');
  }

  /** Number of currently active sessions. */
  get size(): number {
    return this.sessions.size;
  }
}
