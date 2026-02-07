import { tool } from 'ai';
import matter from 'gray-matter';
import { z } from 'zod';
import type { ObsidianService } from '../../obsidian/obsidian.service';
import type { IndexSyncProcessor } from '../../sync/index-sync.processor';
import type { EmbeddingService } from '../../vector/embedding.service';
import type { QdrantService } from '../../vector/qdrant.service';

interface GardenToolsDependencies {
  obsidianService: ObsidianService;
  embeddingService: EmbeddingService;
  qdrantService: QdrantService;
  indexSyncProcessor: IndexSyncProcessor;
}

/**
 * Sanitizes a path by removing invalid filename characters.
 */
function sanitizePath(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Creates digital garden tools for cultivating a knowledge base.
 *
 * These tools follow digital garden principles:
 * - Atomic notes (one concept per note)
 * - Concept-oriented organization
 * - Dense linking with [[wikilinks]]
 * - Maturity stages (seedling -> budding -> evergreen)
 */
export function createGardenTools(deps: GardenToolsDependencies) {
  const {
    obsidianService,
    embeddingService,
    qdrantService,
    indexSyncProcessor,
  } = deps;

  return {
    find_related: tool({
      description:
        'Find notes related to a concept. Use BEFORE planting to check if a note already exists, or to find notes worth linking to.',
      inputSchema: z.object({
        concept: z.string().describe('The concept to search for'),
        limit: z.number().optional().default(5),
      }),
      execute: async ({ concept, limit = 5 }) => {
        try {
          const embedding = await embeddingService.embed(concept);
          const results = await qdrantService.searchSimilarChunks(
            embedding,
            limit,
          );

          if (results.length === 0) {
            return 'No related notes found. This concept appears to be new - safe to plant.';
          }

          let response = '';
          const highMatch = results.find(r => r.score > 0.9);
          const moderateMatches = results.filter(
            r => r.score > 0.7 && r.score <= 0.9,
          );

          if (highMatch) {
            response += `**High similarity match found (${(highMatch.score * 100).toFixed(1)}%):**\n`;
            response += `This concept likely exists at "${highMatch.path.replace(/\.md$/, '')}". Use tend instead of plant.\n\n`;
          }

          if (moderateMatches.length > 0) {
            response += '**Related concepts - consider linking:**\n';
            for (const match of moderateMatches) {
              response += `- ${match.path.replace(/\.md$/, '')} (${(match.score * 100).toFixed(1)}%)\n`;
            }
            response += '\n';
          }

          const otherMatches = results.filter(r => r.score <= 0.7);
          if (otherMatches.length > 0) {
            response += '**Loosely related notes:**\n';
            for (const match of otherMatches) {
              response += `- ${match.path.replace(/\.md$/, '')} (${(match.score * 100).toFixed(1)}%)\n`;
            }
          }

          if (!highMatch && moderateMatches.length === 0) {
            response +=
              '\nNo high-similarity matches. Distinct enough to plant as a new note.';
          }

          return response.trim();
        } catch (error) {
          return `Error searching: ${error.message}`;
        }
      },
    }),

    plant: tool({
      description:
        'Plant a new seedling in the garden. Each note should be atomic (one concept) and concept-oriented (organized by idea, not source). Use find_related first to check if this concept already exists.',
      inputSchema: z.object({
        title: z
          .string()
          .describe(
            'Clear, unique, concept-oriented title. If the name could be ambiguous (e.g., "Luna" could be a person or place), disambiguate: "Luna (Dog)" or use a descriptive title.',
          ),
        content: z
          .string()
          .describe(
            'The knowledge to plant. Use [[wikilinks]] liberally to connect to related concepts.',
          ),
        folder: z
          .string()
          .optional()
          .describe(
            'Optional folder: "People", "Concepts", "Places", "Projects"',
          ),
      }),
      execute: async ({ title, content, folder }) => {
        try {
          const today = new Date().toISOString().split('T')[0];
          const sanitizedTitle = sanitizePath(title);
          const path = folder
            ? `${sanitizePath(folder)}/${sanitizedTitle}`
            : sanitizedTitle;

          // Check if note already exists
          const existing = await obsidianService.readNote(path);
          if (existing) {
            return `Note already exists at "${path}". Use tend to add to it instead.`;
          }

          const finalContent = matter.stringify(`# ${title}\n\n${content}`, {
            maturity: 'seedling',
            planted: today,
            'last-tended': today,
          });

          await obsidianService.writeNote(path, finalContent);
          await indexSyncProcessor.queueSingleNote(path, finalContent);

          return `Planted seedling: ${path}`;
        } catch (error) {
          return `Error planting note: ${error.message}`;
        }
      },
    }),

    tend: tool({
      description:
        'Tend an existing note - add knowledge, refine, or update. Use when you have additional insight about an existing concept. Notes grow through tending.',
      inputSchema: z.object({
        path: z
          .string()
          .describe('Note path (e.g., "People/Luna", "Morning Routine")'),
        content: z
          .string()
          .describe('Content to add. Use [[wikilinks]] for connections.'),
      }),
      execute: async ({ path, content }) => {
        try {
          const note = await obsidianService.readNote(path);
          if (!note) {
            return `Note not found: ${path}. Use plant to create it first.`;
          }

          const parsed = matter(note.content);
          const today = new Date().toISOString().split('T')[0];

          const newContent = matter.stringify(
            `${parsed.content.trim()}\n\n${content}`,
            { ...parsed.data, 'last-tended': today },
          );

          await obsidianService.writeNote(path, newContent);
          await indexSyncProcessor.queueSingleNote(path, newContent);
          return `Tended: ${path}`;
        } catch (error) {
          return `Error tending note: ${error.message}`;
        }
      },
    }),

    connect: tool({
      description:
        "Add a wikilink from one note to another. Dense linking creates the garden's value. Use when you discover a relationship between concepts.",
      inputSchema: z.object({
        from: z.string().describe('Source note path'),
        to: z.string().describe('Target note to link to'),
        context: z
          .string()
          .optional()
          .describe('Optional: add context around the link'),
      }),
      execute: async ({ from, to, context }) => {
        try {
          const note = await obsidianService.readNote(from);
          if (!note) {
            return `Note not found: ${from}`;
          }

          const parsed = matter(note.content);
          const today = new Date().toISOString().split('T')[0];
          const toName = to.replace(/\.md$/, '').split('/').pop();

          const linkText = context
            ? `\n\n${context} [[${toName}]]`
            : `\n\nRelated: [[${toName}]]`;

          const newContent = matter.stringify(
            parsed.content.trim() + linkText,
            { ...parsed.data, 'last-tended': today },
          );

          await obsidianService.writeNote(from, newContent);
          await indexSyncProcessor.queueSingleNote(from, newContent);
          return `Connected ${from} -> ${toName}`;
        } catch (error) {
          return `Error connecting notes: ${error.message}`;
        }
      },
    }),

    recall: tool({
      description:
        'Search the garden semantically. Returns relevant notes with previews. Use to find knowledge before responding to questions.',
      inputSchema: z.object({
        query: z.string().describe('What to search for'),
        limit: z.number().optional().default(5).describe('Max results'),
      }),
      execute: async ({ query, limit = 5 }) => {
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
            response += `Relevance: ${(result.score * 100).toFixed(1)}%\n`;
            response += `${result.contentPreview}\n\n`;
          }

          response += '\n_Use read to get complete content of any note._';
          return response.trim();
        } catch (error) {
          return `Error searching garden: ${error.message}`;
        }
      },
    }),

    read: tool({
      description: 'Read the complete content of a note.',
      inputSchema: z.object({
        path: z
          .string()
          .describe("Note path (e.g., 'People/Luna' or 'People/Luna.md')"),
      }),
      execute: async ({ path }) => {
        try {
          const note = await obsidianService.readNote(path);
          if (!note) {
            return `Note not found: ${path}`;
          }

          const parsed = matter(note.content);
          const maturityIcons: Record<string, string> = {
            seedling: '🌱',
            budding: '🌿',
            evergreen: '🌳',
          };
          const icon = maturityIcons[parsed.data.maturity as string] || '';

          return `**${path}** ${icon}\n\n${parsed.content}`;
        } catch (error) {
          return `Error reading note: ${error.message}`;
        }
      },
    }),

    browse: tool({
      description:
        'Browse the garden. List notes by folder or see recent seedlings that need tending.',
      inputSchema: z.object({
        folder: z
          .string()
          .optional()
          .describe('Folder to browse, or empty for root'),
        maturity: z
          .enum(['seedling', 'budding', 'evergreen'])
          .optional()
          .describe('Filter by maturity stage'),
      }),
      execute: async ({ folder, maturity }) => {
        try {
          const notes = await obsidianService.listNotes(folder);
          if (notes.length === 0) {
            return folder ? `No notes found in: ${folder}` : 'No notes found.';
          }

          // If maturity filter is specified, we need to check each note
          if (maturity) {
            const filtered: string[] = [];
            for (const notePath of notes) {
              const note = await obsidianService.readNote(notePath);
              if (note) {
                const parsed = matter(note.content);
                if (parsed.data.maturity === maturity) {
                  filtered.push(notePath);
                }
              }
            }

            if (filtered.length === 0) {
              return `No ${maturity} notes found${folder ? ` in ${folder}` : ''}.`;
            }

            const maturityIcons: Record<string, string> = {
              seedling: '🌱',
              budding: '🌿',
              evergreen: '🌳',
            };
            const icon = maturityIcons[maturity];

            return `${icon} ${maturity} notes${folder ? ` in ${folder}` : ''}:\n${filtered.map(n => `- ${n.replace(/\.md$/, '')}`).join('\n')}`;
          }

          return `Notes${folder ? ` in ${folder}` : ''}:\n${notes.map(n => `- ${n.replace(/\.md$/, '')}`).join('\n')}`;
        } catch (error) {
          return `Error browsing garden: ${error.message}`;
        }
      },
    }),

    uproot: tool({
      description:
        'Remove a note from the garden. Use sparingly - only for truly obsolete or mistaken notes.',
      inputSchema: z.object({
        path: z.string().describe('Note path to remove'),
      }),
      execute: async ({ path }) => {
        try {
          await obsidianService.deleteNote(path);
          await qdrantService.deleteNote(path);
          return `Uprooted: ${path}`;
        } catch (error) {
          return `Error removing note: ${error.message}`;
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
  };
}

/**
 * @deprecated Use createGardenTools instead. This is kept for backwards compatibility.
 */
export const createMemoryTools = createGardenTools;
