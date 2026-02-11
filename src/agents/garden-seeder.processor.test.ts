import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Job } from 'bullmq';
import type { GardenSeedJob } from '../channels/tools/seed.factory';
import { GardenSeederProcessor } from './garden-seeder.processor';

describe('GardenSeederProcessor', () => {
  let processor: GardenSeederProcessor;
  let mockLlmService: { generate: ReturnType<typeof mock> };
  let mockPromptService: { render: ReturnType<typeof mock> };
  let mockLogger: {
    info: ReturnType<typeof mock>;
    error: ReturnType<typeof mock>;
    debug: ReturnType<typeof mock>;
    setContext: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    mockLlmService = {
      generate: mock(() =>
        Promise.resolve({
          text: '',
          messages: [],
          finishReason: 'stop',
          stepCount: 1,
          toolCallCount: 0,
        }),
      ),
    };

    mockPromptService = {
      render: mock(() => 'You are the garden seeder...'),
    };

    mockLogger = {
      info: mock(),
      error: mock(),
      debug: mock(),
      setContext: mock(),
    };

    processor = new GardenSeederProcessor(
      mockLogger as never,
      mockLlmService as never,
      mockPromptService as never,
      {} as never, // vaultService
      {} as never, // embeddingService
      {} as never, // qdrantService
      {} as never, // indexSyncProcessor
    );
  });

  test('calls LlmService.generate with garden-seeder prompt and tools', async () => {
    const job = {
      id: 'job-1',
      data: {
        description: 'Jackson likes oat milk',
        conversationContext: 'Discussing coffee preferences',
        userId: 42,
        createdAt: new Date().toISOString(),
      },
    } as Job<GardenSeedJob>;

    await processor.process(job);

    expect(mockLlmService.generate).toHaveBeenCalledTimes(1);

    const callArgs = mockLlmService.generate.mock.calls[0][0] as {
      system: string;
      messages: { role: string; content: string }[];
      tools: Record<string, unknown>;
      maxSteps: number;
    };

    expect(callArgs.system).toBe('You are the garden seeder...');
    expect(callArgs.messages).toHaveLength(1);
    expect(callArgs.messages[0].role).toBe('user');
    expect(callArgs.messages[0].content).toContain('Jackson likes oat milk');
    expect(callArgs.messages[0].content).toContain(
      'Discussing coffee preferences',
    );
    expect(callArgs.maxSteps).toBeDefined();

    // Should have core + discovery tools
    expect(callArgs.tools).toHaveProperty('plant');
    expect(callArgs.tools).toHaveProperty('update');
    expect(callArgs.tools).toHaveProperty('read');
    expect(callArgs.tools).toHaveProperty('recall');
    expect(callArgs.tools).toHaveProperty('search_similar');
    expect(callArgs.tools).toHaveProperty('wander');
  });

  test('renders garden-seeder prompt with today date', async () => {
    const job = {
      id: 'job-2',
      data: {
        description: 'Test signal',
        conversationContext: 'Test context',
        userId: 1,
        createdAt: new Date().toISOString(),
      },
    } as Job<GardenSeedJob>;

    await processor.process(job);

    expect(mockPromptService.render).toHaveBeenCalledTimes(1);
    const [promptName, vars] = mockPromptService.render.mock.calls[0] as [
      string,
      { today: string },
    ];
    expect(promptName).toBe('garden-seeder');
    expect(vars.today).toBeDefined();
  });

  test('logs info on start and completion', async () => {
    const job = {
      id: 'job-3',
      data: {
        description: 'Signal',
        conversationContext: 'Context',
        userId: 1,
        createdAt: new Date().toISOString(),
      },
    } as Job<GardenSeedJob>;

    await processor.process(job);

    expect(mockLogger.info).toHaveBeenCalledTimes(2);
  });

  test('rethrows errors from LlmService', async () => {
    mockLlmService.generate = mock(() =>
      Promise.reject(new Error('API rate limit')),
    );

    const job = {
      id: 'job-4',
      data: {
        description: 'Signal',
        conversationContext: 'Context',
        userId: 1,
        createdAt: new Date().toISOString(),
      },
    } as Job<GardenSeedJob>;

    expect(processor.process(job)).rejects.toThrow('API rate limit');
  });
});
