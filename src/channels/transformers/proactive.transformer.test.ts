import { describe, expect, test } from 'bun:test';
import type { TransformContext } from '../channel.types';
import { ProactiveTransformer } from './proactive.transformer';

describe('ProactiveTransformer', () => {
  const transformer = new ProactiveTransformer();

  const baseContext: TransformContext = {
    userId: 123,
  };

  describe('transform', () => {
    test('wraps message with proactive outreach framing', () => {
      const result = transformer.transform('Get the weather', baseContext);

      expect(result).toContain('[PROACTIVE OUTREACH]');
      expect(result).toContain('Task: Get the weather');
      expect(result).toContain('initiating this contact');
    });

    test('includes scheduled time when provided', () => {
      const scheduledTime = new Date('2026-02-07T10:00:00Z');
      const context: TransformContext = {
        ...baseContext,
        scheduledTime,
      };

      const result = transformer.transform('Morning greeting', context);

      expect(result).toContain('Scheduled for:');
      expect(result).toContain(scheduledTime.toLocaleString());
    });

    test('shows "Triggered now" when no scheduled time', () => {
      const result = transformer.transform('Check something', baseContext);

      expect(result).toContain('Triggered now');
    });

    test('includes task ID when provided', () => {
      const context: TransformContext = {
        ...baseContext,
        taskId: 'task-abc-123',
      };

      const result = transformer.transform('Run task', context);

      expect(result).toContain('Task ID: task-abc-123');
    });

    test('instructs LLM to be proactive, not reactive', () => {
      const result = transformer.transform('Any task', baseContext);

      expect(result).toContain("Don't phrase it as answering a question");
      expect(result).toContain("you're reaching out first");
      expect(result).toContain('warm, proactive message');
    });
  });
});
