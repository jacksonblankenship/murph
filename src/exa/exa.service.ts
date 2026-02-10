import { HttpService } from '@nestjs/axios';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { PinoLogger } from 'nestjs-pino';
import { firstValueFrom } from 'rxjs';
import { ExaResponseSchema, ExaSearchResult } from './exa.schemas';

const SEARCH_CACHE_TTL = 3600000; // 1 hour in milliseconds

@Injectable()
export class ExaService {
  private readonly exaApiUrl = 'https://api.exa.ai/search';

  constructor(
    private readonly logger: PinoLogger,
    private configService: ConfigService,
    private httpService: HttpService,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {
    this.logger.setContext(ExaService.name);
  }

  async search(query: string, numResults = 5): Promise<string> {
    const cacheKey = `exa:search:${query}:${numResults}`;

    // Check cache first
    const cached = await this.cache.get<string>(cacheKey);
    if (cached) {
      this.logger.debug({ query }, 'Cache hit');
      return cached;
    }

    try {
      const apiKey = this.configService.get<string>('exa.apiKey');

      if (!apiKey) {
        return 'Error: EXA_API_KEY not configured. Please add it to .env file.';
      }

      const response = await firstValueFrom(
        this.httpService.post(
          this.exaApiUrl,
          {
            query,
            num_results: numResults,
            use_autoprompt: true,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
            },
          },
        ),
      );

      const result = ExaResponseSchema.safeParse(response.data);

      if (!result.success) {
        this.logger.error(
          { error: result.error.message },
          'Invalid Exa API response',
        );
        return this.formatResults([], query);
      }

      const formattedResult = this.formatResults(result.data.results, query);

      // Cache successful results
      await this.cache.set(cacheKey, formattedResult, SEARCH_CACHE_TTL);
      this.logger.debug({ query }, 'Cached search result');

      return formattedResult;
    } catch (error) {
      this.logger.error({ err: error }, 'Exa search error');

      if (error instanceof AxiosError) {
        const status = error.response?.status ?? 'unknown';
        const statusText = error.response?.statusText ?? error.message;
        return `Error performing web search: Exa API error: ${status} ${statusText}`;
      }

      return `Error performing web search: ${error.message}`;
    }
  }

  private formatResults(results: ExaSearchResult[], query: string): string {
    if (results.length === 0) {
      return `No results found for: ${query}`;
    }

    let formatted = `Search results for "${query}":\n\n`;

    results.forEach((result, idx) => {
      formatted += `${idx + 1}. ${result.title}\n`;
      formatted += `   ${result.url}\n`;
      if (result.snippet) {
        formatted += `   ${result.snippet}\n`;
      }
      formatted += '\n';
    });

    return formatted.trim();
  }
}
