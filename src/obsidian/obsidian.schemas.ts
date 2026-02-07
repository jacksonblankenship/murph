import { z } from 'zod';

export const ObsidianNoteSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const ObsidianNoteListSchema = z.object({
  files: z.array(z.string()),
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
export type ObsidianNoteList = z.infer<typeof ObsidianNoteListSchema>;
export type ObsidianSearchResult = z.infer<typeof ObsidianSearchResultSchema>;
