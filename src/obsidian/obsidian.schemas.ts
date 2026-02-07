import { z } from 'zod';

export const ObsidianNoteSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const ObsidianNoteListSchema = z.object({
  files: z.array(z.string()),
});

/**
 * JSON response from Obsidian Local REST API when using
 * Accept: application/vnd.olrapi.note+json header.
 * Includes file metadata like modification time.
 */
export const ObsidianNoteJsonSchema = z.object({
  path: z.string(),
  content: z.string(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  stat: z.object({
    ctime: z.number(),
    mtime: z.number(),
    size: z.number(),
  }),
});

export const ObsidianSearchResultSchema = z.object({
  filename: z.string(),
  score: z.number().optional(),
  matches: z
    .array(
      z.object({
        match: z.object({
          start: z.number(),
          end: z.number(),
        }),
        context: z.string().optional(),
      }),
    )
    .optional(),
});

export const ObsidianSearchResponseSchema = z.array(ObsidianSearchResultSchema);

export type ObsidianNote = z.infer<typeof ObsidianNoteSchema>;
export type ObsidianNoteJson = z.infer<typeof ObsidianNoteJsonSchema>;
export type ObsidianNoteList = z.infer<typeof ObsidianNoteListSchema>;
export type ObsidianSearchResult = z.infer<typeof ObsidianSearchResultSchema>;
