import { beforeEach, describe, expect, test } from 'bun:test';
import type { UserProfileService } from '../../user-profile';
import type { EnrichmentRequest } from '../channel.types';
import { TimeEnricher } from './time.enricher';

/**
 * Creates a mock UserProfileService for testing.
 */
function createMockUserProfileService(
  timezone?: string,
): Pick<UserProfileService, 'getTimezone'> {
  return {
    getTimezone: async () => timezone,
  };
}

describe('TimeEnricher', () => {
  const mockRequest: EnrichmentRequest = {
    message: 'Hello',
    userId: 123,
  };

  describe('enrich', () => {
    test('returns context with current time', async () => {
      const enricher = new TimeEnricher(
        createMockUserProfileService() as UserProfileService,
      );

      const result = await enricher.enrich(mockRequest);

      expect(result.contextAdditions).toBeDefined();
      expect(result.contextAdditions).toContain('[Current time:');
    });

    test('includes formatted date with day of week', async () => {
      const enricher = new TimeEnricher(
        createMockUserProfileService() as UserProfileService,
      );

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
      const enricher = new TimeEnricher(
        createMockUserProfileService() as UserProfileService,
      );

      const result = await enricher.enrich(mockRequest);
      const currentYear = new Date().getFullYear().toString();

      expect(result.contextAdditions).toContain(currentYear);
    });

    test('does not return conversation history', async () => {
      const enricher = new TimeEnricher(
        createMockUserProfileService() as UserProfileService,
      );

      const result = await enricher.enrich(mockRequest);

      expect(result.conversationHistory).toBeUndefined();
    });

    test('falls back to UTC when no timezone is set', async () => {
      const enricher = new TimeEnricher(
        createMockUserProfileService() as UserProfileService,
      );

      const result = await enricher.enrich(mockRequest);

      expect(result.contextAdditions).toContain('UTC');
    });

    test('uses user timezone when set', async () => {
      const enricher = new TimeEnricher(
        createMockUserProfileService('America/New_York') as UserProfileService,
      );

      const result = await enricher.enrich(mockRequest);

      // Should contain EST or EDT depending on time of year
      const hasEasternTime =
        result.contextAdditions?.includes('EST') ||
        result.contextAdditions?.includes('EDT');
      expect(hasEasternTime).toBe(true);
    });
  });
});
