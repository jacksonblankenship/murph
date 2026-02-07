import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingService } from '../vector/embedding.service';
import { QdrantService } from '../vector/qdrant.service';

export interface MemorySearchResult {
  path: string;
  title: string;
  heading?: string;
  contentPreview: string;
  chunkIndex: number;
  totalChunks: number;
  score: number;
}

@Injectable()
export class MemorySearchService {
  private readonly logger = new Logger(MemorySearchService.name);
  private readonly autoInjectThreshold: number;
  private readonly searchLimit: number;
  private readonly maxAutoInjectChunks = 2;

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantService: QdrantService,
    private readonly configService: ConfigService,
  ) {
    this.autoInjectThreshold = this.configService.get<number>(
      'vector.autoInjectThreshold',
    );
    this.searchLimit = this.configService.get<number>('vector.searchLimit');
  }

  /**
   * Search for relevant long-term memory context.
   * Returns formatted context string for high-confidence matches.
   */
  async recallRelevantContext(query: string): Promise<string | null> {
    try {
      const embedding = await this.embeddingService.embed(query);
      const results = await this.qdrantService.searchSimilarChunks(
        embedding,
        this.searchLimit,
      );

      // Only auto-inject high-confidence chunks (>= threshold)
      const highConfidence = results.filter(
        r => r.score >= this.autoInjectThreshold,
      );

      if (highConfidence.length === 0) {
        return null;
      }

      // Limit auto-injected chunks to reduce token usage
      const toInject = highConfidence.slice(0, this.maxAutoInjectChunks);

      const contextParts: string[] = [];
      for (const result of toInject) {
        const heading = result.heading ? ` (${result.heading})` : '';
        const chunkInfo =
          result.totalChunks > 1
            ? ` [chunk ${result.chunkIndex + 1}/${result.totalChunks}]`
            : '';
        contextParts.push(
          `From "${result.title}"${heading}${chunkInfo}:\n${result.contentPreview}`,
        );
      }

      return contextParts.join('\n\n---\n\n');
    } catch (error) {
      this.logger.warn('Failed to recall memory context:', error.message);
      return null;
    }
  }

  /**
   * Search for memories by semantic similarity.
   * Returns raw search results for tool use.
   */
  async searchMemories(
    query: string,
    limit = 5,
  ): Promise<MemorySearchResult[]> {
    try {
      const embedding = await this.embeddingService.embed(query);
      return await this.qdrantService.searchSimilarChunks(embedding, limit);
    } catch (error) {
      this.logger.warn('Failed to search memories:', error.message);
      return [];
    }
  }
}
