import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
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
  constructor(
    private readonly logger: PinoLogger,
    private readonly memorySearchService: MemorySearchService,
  ) {
    this.logger.setContext(MemoryEnricher.name);
  }

  async enrich(request: EnrichmentRequest): Promise<EnrichmentResult> {
    try {
      const memoryContext =
        await this.memorySearchService.recallRelevantContext(request.message);

      if (!memoryContext) {
        return {};
      }

      this.logger.debug(
        { userId: request.userId },
        'Found relevant memory context',
      );

      return {
        contextAdditions: `[Relevant memory context from your notes:]\n${memoryContext}`,
      };
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to enrich with memory context');
      return {};
    }
  }
}
