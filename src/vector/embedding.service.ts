import { createOpenAI } from '@ai-sdk/openai';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { embed, embedMany } from 'ai';

const EMBEDDING_CACHE_TTL = 86400000; // 24 hours in milliseconds

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly model: ReturnType<
    ReturnType<typeof createOpenAI>['embedding']
  >;

  constructor(
    private configService: ConfigService,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {
    const openai = createOpenAI({
      apiKey: this.configService.get<string>('openai.apiKey'),
    });
    this.model = openai.embedding('text-embedding-3-small');
  }

  private async hashContent(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async embed(text: string): Promise<number[]> {
    const hash = await this.hashContent(text);
    const cacheKey = `embedding:${hash}`;

    // Check cache first
    const cached = await this.cache.get<number[]>(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const result = await embed({
        model: this.model,
        value: text,
      });

      // Cache the embedding
      await this.cache.set(cacheKey, result.embedding, EMBEDDING_CACHE_TTL);

      return result.embedding;
    } catch (error) {
      this.logger.error('Error generating embedding:', error.message);
      throw error;
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Check cache for each text
    const results: (number[] | null)[] = [];
    const uncachedTexts: string[] = [];
    const uncachedIndices: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const hash = await this.hashContent(texts[i]);
      const cacheKey = `embedding:${hash}`;
      const cached = await this.cache.get<number[]>(cacheKey);

      if (cached) {
        results[i] = cached;
      } else {
        results[i] = null;
        uncachedTexts.push(texts[i]);
        uncachedIndices.push(i);
      }
    }

    // If all cached, return early
    if (uncachedTexts.length === 0) {
      this.logger.debug(`All ${texts.length} embeddings from cache`);
      return results as number[][];
    }

    try {
      // Generate embeddings for uncached texts
      const result = await embedMany({
        model: this.model,
        values: uncachedTexts,
      });

      // Cache and fill in results
      for (let i = 0; i < uncachedTexts.length; i++) {
        const hash = await this.hashContent(uncachedTexts[i]);
        const cacheKey = `embedding:${hash}`;
        await this.cache.set(
          cacheKey,
          result.embeddings[i],
          EMBEDDING_CACHE_TTL,
        );
        results[uncachedIndices[i]] = result.embeddings[i];
      }

      this.logger.debug(
        `Generated ${uncachedTexts.length} embeddings, ${texts.length - uncachedTexts.length} from cache`,
      );

      return results as number[][];
    } catch (error) {
      this.logger.error('Error generating batch embeddings:', error.message);
      throw error;
    }
  }
}
