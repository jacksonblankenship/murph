import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../../test/mocks/pino-logger.mock';
import { TwilioCallProcessor } from './twilio-call.processor';

describe('TwilioCallProcessor', () => {
  let processor: TwilioCallProcessor;
  let mockTwilioOutboundService: { callUser: ReturnType<typeof mock> };

  beforeEach(() => {
    mockTwilioOutboundService = {
      callUser: mock(() => Promise.resolve('CA-processed-call')),
    };

    processor = new TwilioCallProcessor(
      createMockLogger(),
      mockTwilioOutboundService as never,
    );
  });

  test('initiates outbound call with context', async () => {
    const mockJob = {
      data: { userId: 42, context: 'Morning check-in' },
    };

    const result = await processor.process(mockJob as never);

    expect(mockTwilioOutboundService.callUser).toHaveBeenCalledTimes(1);
    expect(mockTwilioOutboundService.callUser).toHaveBeenCalledWith(
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

    expect(mockTwilioOutboundService.callUser).toHaveBeenCalledWith(
      42,
      undefined,
    );
    expect(result).toBe('CA-processed-call');
  });
});
