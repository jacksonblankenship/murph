import { z } from 'zod';

export const VectorPointSchema = z.object({
  id: z.string(),
  path: z.string(),
  contentHash: z.string(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  updatedAt: z.number(),
  chunkIndex: z.number().optional(),
});

/**
 * Schema for chunk metadata stored in Qdrant
 */
export const ChunkPointSchema = z.object({
  path: z.string(),
  chunkIndex: z.number(),
  totalChunks: z.number(),
  heading: z.string().nullable(),
  contentPreview: z.string(),
  contentHash: z.string(),
  documentHash: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  updatedAt: z.number(),
  type: z.enum(['chunk', 'summary']).optional(),
});

/**
 * Search result with chunk metadata (no full content - lazy loaded)
 */
export const ChunkSearchResultSchema = z.object({
  path: z.string(),
  score: z.number(),
  chunkIndex: z.number(),
  totalChunks: z.number(),
  heading: z.string().nullable(),
  contentPreview: z.string(),
  title: z.string(),
});

export const SearchResultSchema = z.object({
  path: z.string(),
  score: z.number(),
  content: z.string().optional(),
});

export type VectorPoint = z.infer<typeof VectorPointSchema>;
export type ChunkPoint = z.infer<typeof ChunkPointSchema>;
export type ChunkSearchResult = z.infer<typeof ChunkSearchResultSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
