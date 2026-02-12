import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { WebSocket } from 'ws';

/**
 * Active voice call session state.
 */
export interface VoiceSession {
  /** Twilio call SID */
  callSid: string;
  /** User ID associated with this call */
  userId: number;
  /** WebSocket client for this session */
  client: WebSocket;
  /** Abort controller for the current LLM stream */
  abortController?: AbortController;
  /** Context for outbound calls (why Murph is calling) */
  callContext?: string;
  /** Whether the hang_up tool was invoked — end call after response finishes */
  shouldHangUp: boolean;
  /** Timestamp when the session started */
  startTime: number;
}

/**
 * Manages active voice call sessions.
 *
 * Tracks sessions by callSid with a reverse lookup from WebSocket client
 * to callSid for efficient cleanup on disconnect.
 */
@Injectable()
export class VoiceSessionManager {
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly clientToCallSid = new Map<WebSocket, string>();

  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(VoiceSessionManager.name);
  }

  /**
   * Creates a new voice session.
   *
   * @param callSid - Twilio call SID
   * @param userId - User ID for this call
   * @param client - WebSocket connection
   * @param callContext - Optional outbound call context
   * @returns The created session
   */
  create(
    callSid: string,
    userId: number,
    client: WebSocket,
    callContext?: string,
  ): VoiceSession {
    const session: VoiceSession = {
      callSid,
      userId,
      client,
      callContext,
      shouldHangUp: false,
      startTime: Date.now(),
    };

    this.sessions.set(callSid, session);
    this.clientToCallSid.set(client, callSid);

    this.logger.info({ callSid, userId }, 'Voice session created');
    return session;
  }

  /**
   * Gets a session by call SID.
   */
  getByCallSid(callSid: string): VoiceSession | undefined {
    return this.sessions.get(callSid);
  }

  /**
   * Gets a session by WebSocket client.
   */
  getByClient(client: WebSocket): VoiceSession | undefined {
    const callSid = this.clientToCallSid.get(client);
    if (!callSid) return undefined;
    return this.sessions.get(callSid);
  }

  /**
   * Removes a session and cleans up reverse lookup.
   * Aborts any in-progress LLM stream.
   */
  remove(client: WebSocket): void {
    const callSid = this.clientToCallSid.get(client);
    if (!callSid) return;

    const session = this.sessions.get(callSid);
    if (session?.abortController) {
      session.abortController.abort();
    }

    this.sessions.delete(callSid);
    this.clientToCallSid.delete(client);

    this.logger.info({ callSid }, 'Voice session removed');
  }

  /**
   * Returns the number of active sessions.
   */
  get size(): number {
    return this.sessions.size;
  }
}
