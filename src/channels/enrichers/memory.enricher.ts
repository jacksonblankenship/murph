import { Injectable, Logger } from '@nestjs/common';
import { MemorySearchService } from '../../memory/memory-search.service';
import type {
  ContextEnricher,
  EnrichmentRequest,
  EnrichmentResult,
} from '../channel.types';

/**
 * Enriches context with relevant long-term memories.
 *
 * Searches the vector database for semantically similar content
 * and injects high-confidence matches into the context.
 */
@Injectable()
export class MemoryEnricher implements ContextEnricher {
  private readonly logger = new Logger(MemoryEnricher.name);

  constructor(private readonly memorySearchService: MemorySearchService) {}

  async enrich(request: EnrichmentRequest): Promise<EnrichmentResult> {
    try {
      const memoryContext =
        await this.memorySearchService.recallRelevantContext(request.message);

      if (!memoryContext) {
        return {};
      }

      this.logger.debug(
        `Found relevant memory context for user ${request.userId}`,
      );

      return {
        contextAdditions: `[Relevant memory context from your notes:]\n${memoryContext}`,
      };
    } catch (error) {
      this.logger.warn('Failed to enrich with memory context:', error.message);
      return {};
    }
  }
}
