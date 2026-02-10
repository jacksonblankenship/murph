import { Injectable } from '@nestjs/common';
import { UserProfileService } from '../../user-profile';
import type {
  ContextEnricher,
  EnrichmentRequest,
  EnrichmentResult,
} from '../channel.types';

/**
 * Enriches context with current time information.
 *
 * Adds the current date and time so the LLM has temporal awareness
 * without needing to call a tool. Uses the user's configured timezone
 * if available, otherwise falls back to UTC.
 */
@Injectable()
export class TimeEnricher implements ContextEnricher {
  constructor(private readonly userProfileService: UserProfileService) {}

  async enrich(request: EnrichmentRequest): Promise<EnrichmentResult> {
    const now = new Date();
    const timezone = await this.userProfileService.getTimezone(request.userId);

    const formattedTime = now.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone ?? 'UTC',
      timeZoneName: 'short',
    });

    return {
      contextAdditions: `[Current time: ${formattedTime}]`,
    };
  }
}
