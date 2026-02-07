import { Injectable } from '@nestjs/common';
import type {
  ContextEnricher,
  EnrichmentRequest,
  EnrichmentResult,
} from '../channel.types';

/**
 * Enriches context with current time information.
 *
 * Adds the current date and time so the LLM has temporal awareness
 * without needing to call a tool.
 */
@Injectable()
export class TimeEnricher implements ContextEnricher {
  async enrich(_request: EnrichmentRequest): Promise<EnrichmentResult> {
    const now = new Date();

    const formattedTime = now.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });

    return {
      contextAdditions: `[Current time: ${formattedTime}]`,
    };
  }
}
