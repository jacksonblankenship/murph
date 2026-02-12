import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test/mocks/pino-logger.mock';
import { VoiceCallProcessor } from './voice-call.processor';

describe('VoiceCallProcessor', () => {
  let processor: VoiceCallProcessor;
  let mockOutboundCallService: { callUser: ReturnType<typeof mock> };

  beforeEach(() => {
    mockOutboundCallService = {
      callUser: mock(() => Promise.resolve('CA-processed-call')),
    };

    processor = new VoiceCallProcessor(
      createMockLogger(),
      mockOutboundCallService as never,
    );
  });

  test('initiates outbound call with context', async () => {
    const mockJob = {
      data: { userId: 42, context: 'Morning check-in' },
    };

    const result = await processor.process(mockJob as never);

    expect(mockOutboundCallService.callUser).toHaveBeenCalledTimes(1);
    expect(mockOutboundCallService.callUser).toHaveBeenCalledWith(
      42,
      'Morning check-in',
    );
    expect(result).toBe('CA-processed-call');
  });

  test('initiates outbound call without context', async () => {
    const mockJob = {
      data: { userId: 42 },
    };

    const result = await processor.process(mockJob as never);

    expect(mockOutboundCallService.callUser).toHaveBeenCalledWith(
      42,
      undefined,
    );
    expect(result).toBe('CA-processed-call');
  });
});
