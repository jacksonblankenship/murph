import { mock } from 'bun:test';

/**
 * Creates a mock LlmService.
 */
export function createMockLlmService() {
  return {
    generateResponse: mock(() => Promise.resolve('Mock response')),
  };
}

export type MockLlmService = ReturnType<typeof createMockLlmService>;
