import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface ExaSearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

@Injectable()
export class ExaService {
  private readonly exaApiUrl = 'https://api.exa.ai/search';

  constructor(private configService: ConfigService) {}

  async search(query: string, numResults = 5): Promise<string> {
    try {
      const apiKey = this.configService.get<string>('EXA_API_KEY');

      if (!apiKey) {
        return 'Error: EXA_API_KEY not configured. Please add it to .env file.';
      }

      const response = await fetch(this.exaApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          query,
          num_results: numResults,
          use_autoprompt: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`Exa API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      return this.formatResults(data.results || [], query);
    } catch (error) {
      console.error('Exa search error:', error);
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
