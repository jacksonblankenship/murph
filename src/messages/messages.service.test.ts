import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { MessagesService } from './messages.service';

describe('MessagesService', () => {
  let service: MessagesService;
  let mockScheduledMessagesQueue: {
    add: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    mockScheduledMessagesQueue = {
      add: mock(() => Promise.resolve({ id: 'job-456' })),
    };

    // Create service with mocked dependencies
    service = new MessagesService(mockScheduledMessagesQueue as never);
  });

  describe('getScheduledMessagesQueue', () => {
    test('returns the scheduled messages queue', () => {
      const queue = service.getScheduledMessagesQueue();

      expect(queue).toBe(mockScheduledMessagesQueue as never);
    });
  });
});
