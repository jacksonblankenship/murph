import { beforeEach, describe, expect, test } from 'bun:test';
import { createMockLogger } from '../../../test/mocks/pino-logger.mock';
import { VoiceSessionRegistry } from './voice-session.registry';
import type { VoiceCallSession } from './voice-session.types';

function makeFakeSession(sessionId: string): VoiceCallSession {
  return {
    sessionId,
    userId: 42,
    handleInput: async () => {},
    close: () => {},
  };
}

describe('VoiceSessionRegistry', () => {
  let registry: VoiceSessionRegistry;

  beforeEach(() => {
    registry = new VoiceSessionRegistry(createMockLogger());
  });

  test('register + get round-trip', () => {
    const session = makeFakeSession('A');
    registry.register(session);
    expect(registry.get('A')).toBe(session);
  });

  test('get returns undefined for unknown id', () => {
    expect(registry.get('missing')).toBeUndefined();
  });

  test('remove deletes the entry and closes the session', () => {
    let closed = false;
    const session: VoiceCallSession = {
      sessionId: 'A',
      userId: 1,
      handleInput: async () => {},
      close: () => {
        closed = true;
      },
    };
    registry.register(session);
    registry.remove('A');
    expect(registry.get('A')).toBeUndefined();
    expect(closed).toBe(true);
  });

  test('remove is a no-op for unknown id', () => {
    registry.remove('missing');
    expect(registry.size).toBe(0);
  });

  test('size reflects active sessions', () => {
    registry.register(makeFakeSession('A'));
    registry.register(makeFakeSession('B'));
    expect(registry.size).toBe(2);
    registry.remove('A');
    expect(registry.size).toBe(1);
  });

  test('re-registering an id replaces and closes the old session', () => {
    let oldClosed = false;
    const oldSession: VoiceCallSession = {
      sessionId: 'A',
      userId: 1,
      handleInput: async () => {},
      close: () => {
        oldClosed = true;
      },
    };
    const newSession = makeFakeSession('A');
    registry.register(oldSession);
    registry.register(newSession);
    expect(oldClosed).toBe(true);
    expect(registry.get('A')).toBe(newSession);
  });
});
