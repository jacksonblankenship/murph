import { tool } from 'ai';
import { z } from 'zod';
import type { ExaService } from '../../exa/exa.service';

export function createWebSearchTools(exaService: ExaService) {
  return {
    web_search: tool({
      description: 'Search the web for current information using Exa',
      inputSchema: z.object({
        query: z.string().describe('The search query'),
        numResults: z
          .number()
          .optional()
          .describe('Number of results (default 5)'),
      }),
      execute: async ({ query, numResults = 5 }) => {
        return await exaService.search(query, numResults);
      },
    }),
  };
}
