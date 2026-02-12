import { beforeEach, describe, expect, test } from 'bun:test';
import { createMockLogger } from '../../test/mocks/pino-logger.mock';
import { VoiceSessionManager } from './voice-session.manager';

/** Minimal mock WebSocket for testing. */
function createMockClient() {
  return { readyState: 1, OPEN: 1, send: () => {} } as never;
}

describe('VoiceSessionManager', () => {
  let manager: VoiceSessionManager;

  beforeEach(() => {
    manager = new VoiceSessionManager(createMockLogger());
  });

  describe('create', () => {
    test('creates a session with correct properties', () => {
      const client = createMockClient();
      const session = manager.create('CA123', 42, client, 'Morning check-in');

      expect(session.callSid).toBe('CA123');
      expect(session.userId).toBe(42);
      expect(session.client).toBe(client);
      expect(session.callContext).toBe('Morning check-in');
      expect(session.shouldHangUp).toBe(false);
      expect(session.startTime).toBeGreaterThan(0);
    });

    test('increments session count', () => {
      manager.create('CA1', 42, createMockClient());
      manager.create('CA2', 42, createMockClient());

      expect(manager.size).toBe(2);
    });
  });

  describe('getByCallSid', () => {
    test('retrieves session by call SID', () => {
      const client = createMockClient();
      manager.create('CA123', 42, client);

      const session = manager.getByCallSid('CA123');
      expect(session).toBeDefined();
      expect(session!.callSid).toBe('CA123');
    });

    test('returns undefined for unknown call SID', () => {
      expect(manager.getByCallSid('unknown')).toBeUndefined();
    });
  });

  describe('getByClient', () => {
    test('retrieves session by WebSocket client', () => {
      const client = createMockClient();
      manager.create('CA123', 42, client);

      const session = manager.getByClient(client);
      expect(session).toBeDefined();
      expect(session!.callSid).toBe('CA123');
    });

    test('returns undefined for unknown client', () => {
      expect(manager.getByClient(createMockClient())).toBeUndefined();
    });
  });

  describe('remove', () => {
    test('removes session and cleans up reverse lookup', () => {
      const client = createMockClient();
      manager.create('CA123', 42, client);

      manager.remove(client);

      expect(manager.getByCallSid('CA123')).toBeUndefined();
      expect(manager.getByClient(client)).toBeUndefined();
      expect(manager.size).toBe(0);
    });

    test('aborts in-progress stream on removal', () => {
      const client = createMockClient();
      const session = manager.create('CA123', 42, client);
      const abortController = new AbortController();
      session.abortController = abortController;

      manager.remove(client);

      expect(abortController.signal.aborted).toBe(true);
    });

    test('no-op for unknown client', () => {
      manager.remove(createMockClient());
      expect(manager.size).toBe(0);
    });
  });
});
