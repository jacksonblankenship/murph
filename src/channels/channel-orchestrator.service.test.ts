import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/pino-logger.mock';
import { ChannelRegistry } from './channel.registry';
import type {
  ChannelConfig,
  ContextEnricher,
  MessageTransformer,
  OutputHandler,
  ToolFactory,
} from './channel.types';
import {
  type ChannelExecuteRequest,
  ChannelOrchestratorService,
} from './channel-orchestrator.service';

describe('ChannelOrchestratorService', () => {
  let orchestrator: ChannelOrchestratorService;
  let mockRegistry: { get: ReturnType<typeof mock> };
  let mockLlmService: { generate: ReturnType<typeof mock> };
  let mockConversationService: {
    addMessages: ReturnType<typeof mock>;
    extractTurn: ReturnType<typeof mock>;
  };
  let mockConversationVectorService: { storeTurn: ReturnType<typeof mock> };

  const createMockChannel = (
    overrides: Partial<ChannelConfig> = {},
  ): ChannelConfig => ({
    id: 'test-channel',
    systemPrompt: 'Test system prompt',
    transformers: [],
    enrichers: [],
    toolFactories: [],
    outputs: [],
    ...overrides,
  });

  const createMockRequest = (
    overrides: Partial<ChannelExecuteRequest> = {},
  ): ChannelExecuteRequest => ({
    message: 'Hello',
    userId: 123,
    ...overrides,
  });

  beforeEach(() => {
    mockLlmService = {
      generate: mock(() =>
        Promise.resolve({
          text: 'LLM response',
          messages: [{ role: 'assistant', content: 'LLM response' }],
          finishReason: 'stop',
        }),
      ),
    };

    mockConversationService = {
      addMessages: mock(() => Promise.resolve()),
      extractTurn: mock(() => null),
    };

    mockConversationVectorService = {
      storeTurn: mock(() => Promise.resolve()),
    };

    mockRegistry = {
      get: mock(() => createMockChannel()),
    };

    orchestrator = new ChannelOrchestratorService(
      createMockLogger(),
      mockRegistry as never,
      mockLlmService as never,
      mockConversationService as never,
      mockConversationVectorService as never,
    );
  });

  describe('execute', () => {
    test('retrieves channel config from registry', async () => {
      await orchestrator.execute('my-channel', createMockRequest());

      expect(mockRegistry.get).toHaveBeenCalledWith('my-channel');
    });

    test('calls LLM with system prompt and message', async () => {
      const channel = createMockChannel({
        systemPrompt: 'Custom prompt',
      });
      mockRegistry.get = mock(() => channel);

      await orchestrator.execute('test', createMockRequest({ message: 'Hi' }));

      const call = mockLlmService.generate.mock.calls[0][0];
      expect(call.system).toBe('Custom prompt');
      expect(call.messages).toContainEqual({
        role: 'user',
        content: 'Hi',
      });
    });

    test('passes abort signal to LLM', async () => {
      const abortController = new AbortController();

      await orchestrator.execute('test', createMockRequest(), {
        abortSignal: abortController.signal,
      });

      const call = mockLlmService.generate.mock.calls[0][0];
      expect(call.abortSignal).toBe(abortController.signal);
    });

    test('stores conversation after LLM call', async () => {
      await orchestrator.execute(
        'test',
        createMockRequest({ message: 'Hello', userId: 42 }),
      );

      expect(mockConversationService.addMessages).toHaveBeenCalledTimes(1);
      const call = mockConversationService.addMessages.mock.calls[0];
      expect(call[0]).toBe(42); // userId
      expect(call[1][0]).toEqual({ role: 'user', content: 'Hello' });
    });

    test('returns execution result', async () => {
      const result = await orchestrator.execute('test', createMockRequest());

      expect(result.text).toBe('LLM response');
      expect(result.messages).toHaveLength(1);
      expect(result.outputsSent).toBe(false); // No outputs configured
    });
  });

  describe('transformers pipeline', () => {
    test('chains transformers in order', async () => {
      const transformer1: MessageTransformer = {
        transform: (msg: string) => `[1:${msg}]`,
      };
      const transformer2: MessageTransformer = {
        transform: (msg: string) => `[2:${msg}]`,
      };

      mockRegistry.get = mock(() =>
        createMockChannel({
          transformers: [transformer1, transformer2],
        }),
      );

      await orchestrator.execute('test', createMockRequest({ message: 'Hi' }));

      const call = mockLlmService.generate.mock.calls[0][0];
      expect(call.messages).toContainEqual({
        role: 'user',
        content: '[2:[1:Hi]]',
      });
    });

    test('passes context to transformers', async () => {
      const capturedContext: unknown[] = [];
      const transformer: MessageTransformer = {
        transform: (msg: string, ctx) => {
          capturedContext.push(ctx);
          return msg;
        },
      };

      mockRegistry.get = mock(() =>
        createMockChannel({ transformers: [transformer] }),
      );

      await orchestrator.execute(
        'test',
        createMockRequest({
          userId: 123,
          chatId: 456,
          taskId: 'task-abc',
        }),
      );

      expect(capturedContext[0]).toMatchObject({
        userId: 123,
        chatId: 456,
        taskId: 'task-abc',
      });
    });
  });

  describe('enrichers pipeline', () => {
    test('runs enrichers in parallel and merges results', async () => {
      const enricher1: ContextEnricher = {
        enrich: mock(() =>
          Promise.resolve({ contextAdditions: 'Context 1' }),
        ) as never,
      };
      const enricher2: ContextEnricher = {
        enrich: mock(() =>
          Promise.resolve({ contextAdditions: 'Context 2' }),
        ) as never,
      };

      mockRegistry.get = mock(() =>
        createMockChannel({ enrichers: [enricher1, enricher2] }),
      );

      await orchestrator.execute('test', createMockRequest({ message: 'Hi' }));

      // Both enrichers should be called
      expect(enricher1.enrich).toHaveBeenCalled();
      expect(enricher2.enrich).toHaveBeenCalled();

      // Message should include merged context
      const call = mockLlmService.generate.mock.calls[0][0];
      const userMessage = call.messages.find(
        (m: { role: string }) => m.role === 'user',
      );
      expect(userMessage.content).toContain('Context 1');
      expect(userMessage.content).toContain('Context 2');
    });

    test('includes conversation history from enricher', async () => {
      const history = [
        { role: 'user' as const, content: 'Previous message' },
        { role: 'assistant' as const, content: 'Previous response' },
      ];
      const enricher: ContextEnricher = {
        enrich: async () => ({ conversationHistory: history }),
      };

      mockRegistry.get = mock(() =>
        createMockChannel({ enrichers: [enricher] }),
      );

      await orchestrator.execute('test', createMockRequest());

      const call = mockLlmService.generate.mock.calls[0][0];
      expect(call.messages).toHaveLength(3); // 2 history + 1 new
      expect(call.messages[0]).toEqual(history[0]);
      expect(call.messages[1]).toEqual(history[1]);
    });
  });

  describe('tool factories', () => {
    test('composes tools from multiple factories', async () => {
      const factory1: ToolFactory = {
        create: () => ({ tool_a: {} as never }),
      };
      const factory2: ToolFactory = {
        create: () => ({ tool_b: {} as never }),
      };

      mockRegistry.get = mock(() =>
        createMockChannel({ toolFactories: [factory1, factory2] }),
      );

      await orchestrator.execute('test', createMockRequest());

      const call = mockLlmService.generate.mock.calls[0][0];
      expect(call.tools).toHaveProperty('tool_a');
      expect(call.tools).toHaveProperty('tool_b');
    });

    test('passes userId and chatId to tool factories', async () => {
      const capturedDeps: unknown[] = [];
      const factory: ToolFactory = {
        create: deps => {
          capturedDeps.push(deps);
          return {};
        },
      };

      mockRegistry.get = mock(() =>
        createMockChannel({ toolFactories: [factory] }),
      );

      await orchestrator.execute(
        'test',
        createMockRequest({ userId: 42, chatId: 100 }),
      );

      expect(capturedDeps[0]).toEqual({ userId: 42, chatId: 100 });
    });

    test('passes undefined chatId when not provided', async () => {
      const capturedDeps: unknown[] = [];
      const factory: ToolFactory = {
        create: deps => {
          capturedDeps.push(deps);
          return {};
        },
      };

      mockRegistry.get = mock(() =>
        createMockChannel({ toolFactories: [factory] }),
      );

      await orchestrator.execute('test', createMockRequest({ userId: 42 }));

      expect(capturedDeps[0]).toEqual({ userId: 42, chatId: undefined });
    });
  });

  describe('outputs pipeline', () => {
    test('calls all output handlers', async () => {
      const output1: OutputHandler = {
        send: mock(() => Promise.resolve()) as never,
      };
      const output2: OutputHandler = {
        send: mock(() => Promise.resolve()) as never,
      };

      mockRegistry.get = mock(() =>
        createMockChannel({ outputs: [output1, output2] }),
      );

      await orchestrator.execute('test', createMockRequest({ userId: 42 }));

      expect(output1.send).toHaveBeenCalledWith(42, 'LLM response', {
        channelId: 'test',
        chatId: undefined,
        originalMessage: 'Hello',
      });
      expect(output2.send).toHaveBeenCalled();
    });

    test('skips outputs when skipOutputs option is true', async () => {
      const output: OutputHandler = {
        send: mock(() => Promise.resolve()) as never,
      };

      mockRegistry.get = mock(() => createMockChannel({ outputs: [output] }));

      const result = await orchestrator.execute('test', createMockRequest(), {
        skipOutputs: true,
      });

      expect(output.send).not.toHaveBeenCalled();
      expect(result.outputsSent).toBe(false);
    });

    test('uses outputOverrides when provided', async () => {
      const originalOutput: OutputHandler = {
        send: mock(() => Promise.resolve()) as never,
      };
      const overrideOutput: OutputHandler = {
        send: mock(() => Promise.resolve()) as never,
      };

      mockRegistry.get = mock(() =>
        createMockChannel({ outputs: [originalOutput] }),
      );

      await orchestrator.execute('test', createMockRequest(), {
        outputOverrides: [overrideOutput],
      });

      expect(originalOutput.send).not.toHaveBeenCalled();
      expect(overrideOutput.send).toHaveBeenCalled();
    });

    test('returns outputsSent true when outputs succeed', async () => {
      const output: OutputHandler = {
        send: mock(() => Promise.resolve()) as never,
      };

      mockRegistry.get = mock(() => createMockChannel({ outputs: [output] }));

      const result = await orchestrator.execute('test', createMockRequest());

      expect(result.outputsSent).toBe(true);
    });
  });
});
