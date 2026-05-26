import { describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../../test/mocks/pino-logger.mock';
import type { VoiceCallSession } from '../common/voice-session.types';
import { TwilioGateway } from './twilio.gateway';

function createMockSocket() {
  return {
    readyState: 1,
    OPEN: 1,
    send: mock(() => {}),
    on: mock((_e: string, _cb: (...args: unknown[]) => void) => {}),
    close: mock((_code: number, _reason: string) => {}),
  };
}

function createMockConfig(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    'voice.userId': 42,
    'twilio.authToken': '',
    'voice.serverUrl': 'https://murph.test',
  };
  return { get: mock((key: string) => overrides[key] ?? defaults[key]) };
}

function makeGateway(
  registry = {
    register: mock(() => {}),
    get: mock(() => undefined as VoiceCallSession | undefined),
    remove: mock(() => {}),
  },
  orchestrator = { executeStreaming: mock(() => (async function* () {})()) },
  config = createMockConfig(),
) {
  return {
    gateway: new TwilioGateway(
      createMockLogger(),
      config as never,
      registry as never,
      orchestrator as never,
    ),
    registry,
    orchestrator,
    config,
  };
}

describe('TwilioGateway', () => {
  describe('handleConnection signature validation', () => {
    test('allows connection when authToken is unset (dev fallback)', () => {
      const { gateway } = makeGateway();
      const socket = createMockSocket();
      gateway.handleConnection(socket as never, undefined);
      expect(socket.close).not.toHaveBeenCalled();
      expect(socket.on).toHaveBeenCalledWith('message', expect.anything());
    });

    test('closes the socket when authToken set and signature missing', () => {
      const { gateway } = makeGateway(
        undefined,
        undefined,
        createMockConfig({ 'twilio.authToken': 'tok' }),
      );
      const socket = createMockSocket();
      const request = {
        headers: {},
        socket: { remoteAddress: '1.2.3.4' },
      } as never;
      gateway.handleConnection(socket as never, request);
      expect(socket.close).toHaveBeenCalled();
      expect(socket.on).not.toHaveBeenCalled();
    });
  });

  describe('message dispatch', () => {
    test('setup creates a session and registers it', () => {
      const registry = {
        register: mock(() => {}),
        get: mock(() => undefined),
        remove: mock(() => {}),
      };
      const { gateway } = makeGateway(registry);
      const socket = createMockSocket();
      gateway.handleConnection(socket as never, undefined);
      const handler = socket.on.mock.calls[0][1] as (d: string) => void;
      handler(
        JSON.stringify({
          type: 'setup',
          callSid: 'CA1',
          from: '+1',
          to: '+2',
          direction: 'inbound',
          customParameters: { callContext: 'check-in' },
        }),
      );
      expect(registry.register).toHaveBeenCalledTimes(1);
      const registered = (
        registry.register.mock.calls as unknown as VoiceCallSession[][]
      )[0][0];
      expect(registered.sessionId).toBe('CA1');
      expect(registered.userId).toBe(42);
    });

    test('prompt forwards transcript to the session', async () => {
      const session: VoiceCallSession & {
        handleInput: ReturnType<typeof mock>;
      } = {
        sessionId: 'CA1',
        userId: 42,
        handleInput: mock(async (_e: unknown) => {}),
        close: () => {},
      };
      const registry = {
        register: mock(() => {}),
        get: mock(() => session),
        remove: mock(() => {}),
      };
      const { gateway } = makeGateway(registry);
      const socket = createMockSocket();
      gateway.handleConnection(socket as never, undefined);
      const handler = socket.on.mock.calls[0][1] as (d: string) => void;
      // Setup first so the gateway has a sessionId for this socket.
      handler(
        JSON.stringify({
          type: 'setup',
          callSid: 'CA1',
          from: '+1',
          to: '+2',
          direction: 'inbound',
        }),
      );
      handler(
        JSON.stringify({ type: 'prompt', voicePrompt: 'hello', last: true }),
      );
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(session.handleInput).toHaveBeenCalledWith({
        type: 'transcript',
        text: 'hello',
        isFinal: true,
      });
    });

    test('prompt isFinal defaults to true if last is omitted', async () => {
      const session: VoiceCallSession & {
        handleInput: ReturnType<typeof mock>;
      } = {
        sessionId: 'CA1',
        userId: 42,
        handleInput: mock(async () => {}),
        close: () => {},
      };
      const registry = {
        register: mock(() => {}),
        get: mock(() => session),
        remove: mock(() => {}),
      };
      const { gateway } = makeGateway(registry);
      const socket = createMockSocket();
      gateway.handleConnection(socket as never, undefined);
      const handler = socket.on.mock.calls[0][1] as (d: string) => void;
      handler(
        JSON.stringify({
          type: 'setup',
          callSid: 'CA1',
          from: '+1',
          to: '+2',
          direction: 'inbound',
        }),
      );
      handler(JSON.stringify({ type: 'prompt', voicePrompt: 'hi' }));
      await new Promise(resolve => setTimeout(resolve, 5));
      const event = (session.handleInput.mock.calls[0] as unknown[])[0] as {
        isFinal: boolean;
      };
      expect(event.isFinal).toBe(true);
    });

    test('interrupt forwards to the session', async () => {
      const session: VoiceCallSession & {
        handleInput: ReturnType<typeof mock>;
      } = {
        sessionId: 'CA1',
        userId: 42,
        handleInput: mock(async () => {}),
        close: () => {},
      };
      const registry = {
        register: mock(() => {}),
        get: mock(() => session),
        remove: mock(() => {}),
      };
      const { gateway } = makeGateway(registry);
      const socket = createMockSocket();
      gateway.handleConnection(socket as never, undefined);
      const handler = socket.on.mock.calls[0][1] as (d: string) => void;
      handler(
        JSON.stringify({
          type: 'setup',
          callSid: 'CA1',
          from: '+1',
          to: '+2',
          direction: 'inbound',
        }),
      );
      handler(JSON.stringify({ type: 'interrupt' }));
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(session.handleInput).toHaveBeenCalledWith({ type: 'interrupt' });
    });

    test('handleDisconnect removes the session from the registry', () => {
      const registry = {
        register: mock(() => {}),
        get: mock(() => undefined),
        remove: mock(() => {}),
      };
      const { gateway } = makeGateway(registry);
      const socket = createMockSocket();
      gateway.handleConnection(socket as never, undefined);
      const handler = socket.on.mock.calls[0][1] as (d: string) => void;
      handler(
        JSON.stringify({
          type: 'setup',
          callSid: 'CA9',
          from: '+1',
          to: '+2',
          direction: 'inbound',
        }),
      );
      gateway.handleDisconnect(socket as never);
      expect(registry.remove).toHaveBeenCalledWith('CA9');
    });

    test('malformed JSON does not throw or close the socket', () => {
      const { gateway } = makeGateway();
      const socket = createMockSocket();
      gateway.handleConnection(socket as never, undefined);
      const handler = socket.on.mock.calls[0][1] as (d: string) => void;
      expect(() => handler('not json')).not.toThrow();
      expect(socket.close).not.toHaveBeenCalled();
    });
  });
});
