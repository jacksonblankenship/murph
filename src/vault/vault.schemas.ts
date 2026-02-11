import { z } from 'zod';

/**
 * Valid growth stages for notes in the digital garden.
 *
 * - seedling: New, rough idea
 * - budding: Developing, has some connections
 * - evergreen: Well-connected, thoroughly developed
 */
export const GrowthStageSchema = z.enum(['seedling', 'budding', 'evergreen']);

export type GrowthStage = z.infer<typeof GrowthStageSchema>;

/**
 * Schema for note frontmatter in the digital garden.
 *
 * Uses `.passthrough()` to preserve custom keys that users may add
 * beyond the standard garden fields.
 */
export const NoteFrontmatterSchema = z
  .object({
    growth_stage: GrowthStageSchema.optional(),
    last_tended: z.string().optional(),
    summary: z.string().default(''),
    aliases: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
  })
  .passthrough();

export type NoteFrontmatter = z.infer<typeof NoteFrontmatterSchema>;
