import { tool } from 'ai';
import { z } from 'zod';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_TRAVERSE_DEPTH,
  MS_PER_DAY,
  ORPHAN_MAX_AGE_DAYS,
  PERCENT_DECIMALS_PRECISE,
  PERCENT_MULTIPLIER,
  PREVIEW_LENGTH_LONG,
  SHUFFLE_MIDPOINT,
  SIMILARITY_HIGH_LOWER,
  SIMILARITY_MODERATE,
  SIMILARITY_VERY_HIGH,
  WANDER_LIMIT,
} from './constants';
import type { GardenToolsDependencies } from './types';

/**
 * Creates discovery tools for finding and exploring notes.
 *
 * Includes: search_similar, recall, wander, get_surrounding_chunks, traverse
 */
export function createDiscoveryTools(deps: GardenToolsDependencies) {
  const { vaultService, embeddingService, qdrantService } = deps;

  return {
    search_similar: tool({
      description:
        'Find notes similar to a concept or topic. Use BEFORE planting to check if a note already exists, or to find duplicates and merge candidates. Returns categorized results with similarity scores.',
      inputSchema: z.object({
        query: z.string().describe('The concept or content to search for'),
        threshold: z
          .number()
          .optional()
          .default(SIMILARITY_MODERATE)
          .describe(
            'Minimum similarity score (0-1). Default 0.7 for moderate matches. Use 0.85+ for duplicates.',
          ),
        limit: z
          .number()
          .optional()
          .default(DEFAULT_SEARCH_LIMIT)
          .describe('Max results'),
        showMergeHints: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            'Show colored indicators for merge candidates (🔴 very high, 🟠 high, 🟡 moderate)',
          ),
      }),
      execute: async ({
        query,
        threshold = SIMILARITY_MODERATE,
        limit = DEFAULT_SEARCH_LIMIT,
        showMergeHints = true,
      }) => {
        try {
          const embedding = await embeddingService.embed(query);
          const results = await qdrantService.searchSimilarChunks(
            embedding,
            limit * 2,
          );

          // Filter by threshold and dedupe by path
          const seen = new Set<string>();
          const filtered = results
            .filter(r => {
              if (r.score < threshold) return false;
              const path = r.path.replace(/\.md$/, '');
              if (seen.has(path)) return false;
              seen.add(path);
              return true;
            })
            .slice(0, limit);

          if (filtered.length === 0) {
            if (threshold >= SIMILARITY_MODERATE) {
              return `No notes found with similarity ≥ ${(threshold * PERCENT_MULTIPLIER).toFixed(0)}%. This concept appears to be new - safe to plant.`;
            }
            return `No notes found with similarity ≥ ${(threshold * PERCENT_MULTIPLIER).toFixed(0)}%. Try lowering the threshold.`;
          }

          let response = `**Similar notes (threshold: ${(threshold * PERCENT_MULTIPLIER).toFixed(0)}%):**\n\n`;

          for (const result of filtered) {
            const displayPath = result.path.replace(/\.md$/, '');
            const similarityPct = (result.score * PERCENT_MULTIPLIER).toFixed(
              PERCENT_DECIMALS_PRECISE,
            );

            if (showMergeHints) {
              if (result.score >= SIMILARITY_VERY_HIGH) {
                response += `🔴 **${displayPath}** (${similarityPct}%) - Very high similarity, likely duplicate\n`;
              } else if (result.score >= SIMILARITY_HIGH_LOWER) {
                response += `🟠 **${displayPath}** (${similarityPct}%) - High similarity, consider merging\n`;
              } else {
                response += `🟡 **${displayPath}** (${similarityPct}%) - Moderate similarity, worth reviewing\n`;
              }
            } else {
              response += `- ${displayPath} (${similarityPct}%)\n`;
            }
          }

          if (showMergeHints) {
            response +=
              '\n_Use read to compare content, then merge if they cover the same concept._';
          }

          return response.trim();
        } catch (error) {
          return `Error searching: ${error.message}`;
        }
      },
    }),

    recall: tool({
      description:
        'Search the garden semantically. Returns relevant notes with previews. Use to find knowledge before responding to questions.',
      inputSchema: z.object({
        query: z.string().describe('What to search for'),
        limit: z
          .number()
          .optional()
          .default(DEFAULT_SEARCH_LIMIT)
          .describe('Max results'),
      }),
      execute: async ({ query, limit = DEFAULT_SEARCH_LIMIT }) => {
        try {
          const embedding = await embeddingService.embed(query);
          const results = await qdrantService.searchSimilarChunks(
            embedding,
            limit,
          );

          if (results.length === 0) {
            return 'No relevant notes found.';
          }

          let response = `Found ${results.length} relevant notes:\n\n`;
          for (const result of results) {
            const displayPath = result.path.replace(/\.md$/, '');
            const heading = result.heading ? ` > ${result.heading}` : '';
            const chunkInfo =
              result.totalChunks > 1
                ? ` [${result.chunkIndex + 1}/${result.totalChunks}]`
                : '';
            response += `**${result.title}** (${displayPath}${heading})${chunkInfo}\n`;
            response += `Relevance: ${(result.score * PERCENT_MULTIPLIER).toFixed(PERCENT_DECIMALS_PRECISE)}%\n`;
            response += `${result.contentPreview}\n\n`;
          }

          response += '\n_Use read to get complete content of any note._';
          return response.trim();
        } catch (error) {
          return `Error searching garden: ${error.message}`;
        }
      },
    }),

    wander: tool({
      description:
        'Discover notes serendipitously. Returns random notes for unexpected connections and rediscovery.',
      inputSchema: z.object({
        growth_stage: z
          .enum(['seedling', 'budding', 'evergreen'])
          .optional()
          .describe('Filter by growth stage'),
        excludeRecentDays: z
          .number()
          .optional()
          .default(ORPHAN_MAX_AGE_DAYS)
          .describe('Exclude notes tended in the last N days'),
        limit: z
          .number()
          .optional()
          .default(WANDER_LIMIT)
          .describe('Number of notes'),
      }),
      execute: async ({
        growth_stage,
        excludeRecentDays = ORPHAN_MAX_AGE_DAYS,
        limit = WANDER_LIMIT,
      }) => {
        try {
          const notes = vaultService.getAllNotes();
          if (notes.length === 0) {
            return 'No notes in garden to wander through.';
          }

          const now = new Date();
          const cutoffDate = new Date(
            now.getTime() - excludeRecentDays * MS_PER_DAY,
          );

          // Filter notes based on criteria
          const candidates: { path: string; content: string }[] = [];
          for (const note of notes) {
            // Check growth stage filter
            if (growth_stage && note.frontmatter.growth_stage !== growth_stage)
              continue;

            // Check recency filter
            const lastTended = note.frontmatter.last_tended;
            if (lastTended) {
              const tendedDate = new Date(lastTended);
              if (tendedDate > cutoffDate) continue;
            }

            candidates.push({
              path: note.path.replace(/\.md$/, ''),
              content: note.body,
            });
          }

          if (candidates.length === 0) {
            const filters = [];
            if (growth_stage) filters.push(`growth stage: ${growth_stage}`);
            if (excludeRecentDays > 0)
              filters.push(`not tended in ${excludeRecentDays} days`);
            return `No notes found matching criteria${filters.length ? ` (${filters.join(', ')})` : ''}.`;
          }

          // Randomly select notes
          const selected: typeof candidates = [];
          const shuffled = [...candidates].sort(
            () => Math.random() - SHUFFLE_MIDPOINT,
          );
          for (let i = 0; i < Math.min(limit, shuffled.length); i++) {
            selected.push(shuffled[i]);
          }

          let response = '**Wandering through the garden...**\n\n';
          for (const note of selected) {
            const preview =
              note.content.length > PREVIEW_LENGTH_LONG
                ? `${note.content.slice(0, PREVIEW_LENGTH_LONG)}...`
                : note.content;
            response += `**${note.path}**\n${preview}\n\n`;
          }
          response +=
            '_These notes may have unexpected connections worth exploring._';

          return response.trim();
        } catch (error) {
          return `Error wandering: ${error.message}`;
        }
      },
    }),

    get_surrounding_chunks: tool({
      description:
        'Get chunks before and after a specific chunk for more context. Useful when a recall result mentions a chunk index and you need surrounding context.',
      inputSchema: z.object({
        path: z.string().describe('Note path'),
        chunkIndex: z.number().describe('The chunk index to expand around'),
        range: z
          .number()
          .optional()
          .default(1)
          .describe('Number of chunks before/after to include'),
      }),
      execute: async ({ path, chunkIndex, range = 1 }) => {
        try {
          const chunks = await qdrantService.getSurroundingChunks(
            path,
            chunkIndex,
            range,
          );

          if (chunks.length === 0) {
            return `No chunks found for: ${path}`;
          }

          let response = `Chunks from "${chunks[0].title}":\n\n`;
          for (const chunk of chunks) {
            const heading = chunk.heading ? ` (${chunk.heading})` : '';
            const isCurrent = chunk.chunkIndex === chunkIndex;
            const marker = isCurrent ? '>>> ' : '';
            response += `${marker}[Chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks}]${heading}\n`;
            response += `${chunk.contentPreview}\n\n`;
          }

          return response.trim();
        } catch (error) {
          return `Error getting surrounding chunks: ${error.message}`;
        }
      },
    }),

    traverse: tool({
      description:
        'Explore the garden by following links from a note. Use to discover related concepts and understand the knowledge graph.',
      inputSchema: z.object({
        from: z.string().describe('Starting note path'),
        direction: z
          .enum(['outbound', 'inbound', 'both'])
          .optional()
          .default('both')
          .describe('Direction to traverse: outbound, inbound, or both'),
        depth: z
          .number()
          .optional()
          .default(1)
          .describe('Link hops to follow (1-3)'),
      }),
      execute: async ({ from, direction = 'both', depth = 1 }) => {
        try {
          const clampedDepth = Math.min(Math.max(depth, 1), MAX_TRAVERSE_DEPTH);
          const normalizedFrom = from.replace(/\.md$/, '');

          const startNote = vaultService.getNote(normalizedFrom);
          if (!startNote) {
            return `Note not found: ${from}`;
          }

          // Build link maps from in-memory vault
          const allNotes = vaultService.getAllNotes();
          const outboundMap = new Map<string, string[]>();
          const inboundMap = new Map<string, string[]>();
          const validPaths = new Set(
            allNotes.map(n => n.path.replace(/\.md$/, '')),
          );

          for (const note of allNotes) {
            const notePath = note.path.replace(/\.md$/, '');
            const outbound: string[] = [];

            for (const linkTarget of note.outboundLinks) {
              const targetPath = [...validPaths].find(
                p => p === linkTarget || p.endsWith(`/${linkTarget}`),
              );
              if (targetPath && targetPath !== notePath) {
                outbound.push(targetPath);
                if (!inboundMap.has(targetPath)) {
                  inboundMap.set(targetPath, []);
                }
                inboundMap.get(targetPath)?.push(notePath);
              }
            }
            outboundMap.set(notePath, outbound);
          }

          // BFS traversal
          const visited = new Set<string>();
          const result: { path: string; depth: number; direction: string }[] =
            [];

          interface QueueItem {
            path: string;
            currentDepth: number;
            dir: 'outbound' | 'inbound';
          }
          const queue: QueueItem[] = [];

          if (direction === 'outbound' || direction === 'both') {
            for (const target of outboundMap.get(normalizedFrom) || []) {
              queue.push({ path: target, currentDepth: 1, dir: 'outbound' });
            }
          }
          if (direction === 'inbound' || direction === 'both') {
            for (const source of inboundMap.get(normalizedFrom) || []) {
              queue.push({ path: source, currentDepth: 1, dir: 'inbound' });
            }
          }

          while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;
            if (visited.has(item.path)) continue;
            visited.add(item.path);

            result.push({
              path: item.path,
              depth: item.currentDepth,
              direction: item.dir,
            });

            if (item.currentDepth < clampedDepth) {
              if (item.dir === 'outbound') {
                for (const target of outboundMap.get(item.path) || []) {
                  if (!visited.has(target)) {
                    queue.push({
                      path: target,
                      currentDepth: item.currentDepth + 1,
                      dir: 'outbound',
                    });
                  }
                }
              } else {
                for (const source of inboundMap.get(item.path) || []) {
                  if (!visited.has(source)) {
                    queue.push({
                      path: source,
                      currentDepth: item.currentDepth + 1,
                      dir: 'inbound',
                    });
                  }
                }
              }
            }
          }

          if (result.length === 0) {
            return `No ${direction === 'both' ? '' : `${direction} `}connections found from "${normalizedFrom}".`;
          }

          let response = `**Traversal from "${normalizedFrom}"** (depth: ${clampedDepth}, direction: ${direction})\n\n`;

          // Group by depth
          for (let d = 1; d <= clampedDepth; d++) {
            const atDepth = result.filter(r => r.depth === d);
            if (atDepth.length === 0) continue;

            response += `**${d} hop${d > 1 ? 's' : ''} away:**\n`;
            for (const item of atDepth) {
              const arrow = item.direction === 'outbound' ? '->' : '<-';
              response += `  ${arrow} ${item.path}\n`;
            }
            response += '\n';
          }

          return response.trim();
        } catch (error) {
          return `Error traversing: ${error.message}`;
        }
      },
    }),
  };
}
