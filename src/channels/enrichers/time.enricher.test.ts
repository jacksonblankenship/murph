import { describe, expect, test } from 'bun:test';
import type { EnrichmentRequest } from '../channel.types';
import { TimeEnricher } from './time.enricher';

describe('TimeEnricher', () => {
  const enricher = new TimeEnricher();

  const mockRequest: EnrichmentRequest = {
    message: 'Hello',
    userId: 123,
  };

  describe('enrich', () => {
    test('returns context with current time', async () => {
      const result = await enricher.enrich(mockRequest);

      expect(result.contextAdditions).toBeDefined();
      expect(result.contextAdditions).toContain('[Current time:');
    });

    test('includes formatted date with day of week', async () => {
      const result = await enricher.enrich(mockRequest);

      // Should contain a day of week (one of these)
      const daysOfWeek = [
        'Sunday',
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
      ];
      const hasDayOfWeek = daysOfWeek.some(day =>
        result.contextAdditions?.includes(day),
      );

      expect(hasDayOfWeek).toBe(true);
    });

    test('includes year', async () => {
      const result = await enricher.enrich(mockRequest);
      const currentYear = new Date().getFullYear().toString();

      expect(result.contextAdditions).toContain(currentYear);
    });

    test('does not return conversation history', async () => {
      const result = await enricher.enrich(mockRequest);

      expect(result.conversationHistory).toBeUndefined();
    });
  });
});
