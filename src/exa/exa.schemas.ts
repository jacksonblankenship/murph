import { z } from 'zod';

export const ExaSearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string().optional(),
  score: z.number().optional(),
});

export const ExaResponseSchema = z.object({
  results: z.array(ExaSearchResultSchema).optional().default([]),
});

export type ExaSearchResult = z.infer<typeof ExaSearchResultSchema>;
export type ExaResponse = z.infer<typeof ExaResponseSchema>;
