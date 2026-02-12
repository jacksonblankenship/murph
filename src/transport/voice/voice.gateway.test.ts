import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test/mocks/pino-logger.mock';
import { VoiceGateway } from './voice.gateway';
import type { VoiceSession } from './voice-session.manager';

/** Creates a mock WebSocket client. */
function createMockClient() {
  return {
    readyState: 1,
    OPEN: 1,
    send: mock(() => {}),
    on: mock((_event: string, _handler: (...args: unknown[]) => void) => {}),
  };
}

/** Creates a mock session manager. */
function createMockSessionManager() {
  const sessions = new Map<unknown, VoiceSession>();

  return {
    create: mock(
      (
        callSid: string,
        userId: number,
        client: unknown,
        callContext?: string,
      ) => {
        const session: VoiceSession = {
          callSid,
          userId,
          client: client as never,
          callContext,
          shouldHangUp: false,
          startTime: Date.now(),
        };
        sessions.set(client, session);
        return session;
      },
    ),
    getByClient: mock((client: unknown) => sessions.get(client)),
    getByCallSid: mock(
      (_callSid: string) => undefined as VoiceSession | undefined,
    ),
    remove: mock((client: unknown) => {
      sessions.delete(client);
    }),
    get size() {
      return sessions.size;
    },
  };
}

describe('VoiceGateway', () => {
  let gateway: VoiceGateway;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockOrchestrator: { executeStreaming: ReturnType<typeof mock> };
  let mockConfigService: { get: ReturnType<typeof mock> };

  beforeEach(() => {
    mockSessionManager = createMockSessionManager();

    mockOrchestrator = {
      executeStreaming: mock(function* () {
        yield { type: 'text-delta', delta: 'Hello ' };
        yield { type: 'text-delta', delta: 'there!' };
        yield { type: 'finish' };
      }),
    };

    mockConfigService = {
      get: mock((key: string) => {
        if (key === 'voice.userId') return 42;
        return undefined;
      }),
    };

    gateway = new VoiceGateway(
      createMockLogger(),
      mockConfigService as never,
      mockSessionManager as never,
      mockOrchestrator as never,
    );
  });

  describe('handleConnection', () => {
    test('registers message handler on client', () => {
      const client = createMockClient();
      gateway.handleConnection(client as never);

      expect(client.on).toHaveBeenCalledTimes(1);
      expect(client.on.mock.calls[0][0]).toBe('message');
    });
  });

  describe('handleDisconnect', () => {
    test('removes session on disconnect', () => {
      const client = createMockClient();

      // Setup session first
      mockSessionManager.create('CA123', 42, client);

      gateway.handleDisconnect(client as never);

      expect(mockSessionManager.remove).toHaveBeenCalledWith(client);
    });
  });

  describe('setup message', () => {
    test('creates session from setup message', () => {
      const client = createMockClient();
      gateway.handleConnection(client as never);

      // Get the message handler
      const messageHandler = client.on.mock.calls[0][1] as (
        data: string,
      ) => void;

      // Send setup message
      messageHandler(
        JSON.stringify({
          type: 'setup',
          callSid: 'CA123',
          from: '+15551234567',
          to: '+15559876543',
          direction: 'inbound',
        }),
      );

      expect(mockSessionManager.create).toHaveBeenCalledTimes(1);
      const call = mockSessionManager.create.mock.calls[0];
      expect(call[0]).toBe('CA123');
      expect(call[1]).toBe(42); // userId from config
    });

    test('extracts callContext from outbound setup', () => {
      const client = createMockClient();
      gateway.handleConnection(client as never);

      const messageHandler = client.on.mock.calls[0][1] as (
        data: string,
      ) => void;

      messageHandler(
        JSON.stringify({
          type: 'setup',
          callSid: 'CA456',
          from: '+15551234567',
          to: '+15559876543',
          direction: 'outbound-api',
          customParameters: { callContext: 'Morning check-in' },
        }),
      );

      const call = mockSessionManager.create.mock.calls[0];
      expect(call[3]).toBe('Morning check-in');
    });
  });

  describe('prompt message', () => {
    test('streams LLM response as text messages', async () => {
      const client = createMockClient();
      gateway.handleConnection(client as never);

      const messageHandler = client.on.mock.calls[0][1] as (
        data: string,
      ) => void;

      // Setup session
      messageHandler(
        JSON.stringify({
          type: 'setup',
          callSid: 'CA123',
          from: '+1',
          to: '+2',
          direction: 'inbound',
        }),
      );

      // Use an async generator for the mock
      mockOrchestrator.executeStreaming = mock(async function* () {
        yield { type: 'text-delta', delta: 'Hello ' };
        yield { type: 'text-delta', delta: 'there!' };
        yield { type: 'finish' };
      });

      // Send prompt
      messageHandler(
        JSON.stringify({
          type: 'prompt',
          voicePrompt: 'How are you?',
        }),
      );

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have sent text tokens + last marker
      const sentMessages = client.send.mock.calls.map((c: unknown[]) =>
        JSON.parse(c[0] as string),
      );

      const textMessages = sentMessages.filter(
        (m: { type: string }) => m.type === 'text',
      );
      expect(textMessages.length).toBeGreaterThanOrEqual(2);

      // Check for text deltas
      const deltas = textMessages.filter(
        (m: { token: string; last: boolean }) => !m.last,
      );
      expect(deltas[0].token).toBe('Hello ');
      expect(deltas[1].token).toBe('there!');

      // Check for last marker
      const lastMessage = textMessages.find((m: { last: boolean }) => m.last);
      expect(lastMessage).toBeDefined();
    });

    test('detects hang_up tool call and sends end message', async () => {
      const client = createMockClient();
      gateway.handleConnection(client as never);

      const messageHandler = client.on.mock.calls[0][1] as (
        data: string,
      ) => void;

      // Setup session
      messageHandler(
        JSON.stringify({
          type: 'setup',
          callSid: 'CA123',
          from: '+1',
          to: '+2',
          direction: 'inbound',
        }),
      );

      mockOrchestrator.executeStreaming = mock(async function* () {
        yield { type: 'text-delta', delta: 'Bye!' };
        yield { type: 'tool-call', toolName: 'hang_up' };
        yield { type: 'finish' };
      });

      messageHandler(
        JSON.stringify({
          type: 'prompt',
          voicePrompt: 'Goodbye!',
        }),
      );

      // Wait for async processing + the 500ms setTimeout for end
      await new Promise(resolve => setTimeout(resolve, 600));

      const sentMessages = client.send.mock.calls.map((c: unknown[]) =>
        JSON.parse(c[0] as string),
      );

      const endMessage = sentMessages.find(
        (m: { type: string }) => m.type === 'end',
      );
      expect(endMessage).toBeDefined();
    });
  });

  describe('interrupt message', () => {
    test('aborts current stream on interrupt', () => {
      const client = createMockClient();
      gateway.handleConnection(client as never);

      const messageHandler = client.on.mock.calls[0][1] as (
        data: string,
      ) => void;

      // Setup session with an abort controller
      messageHandler(
        JSON.stringify({
          type: 'setup',
          callSid: 'CA123',
          from: '+1',
          to: '+2',
          direction: 'inbound',
        }),
      );

      const session = mockSessionManager.getByClient(client);
      const abortController = new AbortController();
      session!.abortController = abortController;

      // Send interrupt
      messageHandler(JSON.stringify({ type: 'interrupt' }));

      expect(abortController.signal.aborted).toBe(true);
    });
  });
});
