import { tool } from 'ai';
import matter from 'gray-matter';
import { z } from 'zod';
import type { ObsidianService } from '../../obsidian/obsidian.service';
import type { IndexSyncProcessor } from '../../sync/index-sync.processor';
import type { EmbeddingService } from '../../vector/embedding.service';
import type { QdrantService } from '../../vector/qdrant.service';

interface MemoryToolsDependencies {
  obsidianService: ObsidianService;
  embeddingService: EmbeddingService;
  qdrantService: QdrantService;
  indexSyncProcessor: IndexSyncProcessor;
}

function sanitizePath(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createMemoryTools(deps: MemoryToolsDependencies) {
  const {
    obsidianService,
    embeddingService,
    qdrantService,
    indexSyncProcessor,
  } = deps;

  return {
    save_memory: tool({
      description:
        'Save information to long-term memory. Automatically finds and updates existing memories on the same topic to avoid duplicates.',
      inputSchema: z.object({
        about: z
          .string()
          .describe("What/who this is about (e.g., 'Luna', 'Jackson's job')"),
        memory: z
          .string()
          .describe(
            'The information to remember. Use [[Name]] to link to related memories.',
          ),
      }),
      execute: async ({ about, memory }) => {
        try {
          const today = new Date().toISOString().split('T')[0];

          const embedding = await embeddingService.embed(about);
          const matches = await qdrantService.searchSimilarChunks(embedding, 3);
          const existing = matches.find(m => m.score > 0.85);

          let finalContent: string;
          let path: string;

          if (existing) {
            const existingNote = await obsidianService.readNote(existing.path);
            if (!existingNote) {
              return `Error: Could not read existing memory at ${existing.path}`;
            }

            const parsed = matter(existingNote.content);
            const mergedContent = `${parsed.content.trim()}\n\n${memory}`;

            finalContent = matter.stringify(mergedContent, {
              ...parsed.data,
              'last-tended': today,
            });
            path = existing.path.replace(/\.md$/, '');
          } else {
            finalContent = matter.stringify(`# ${about}\n\n${memory}`, {
              maturity: 'seedling',
              planted: today,
              'last-tended': today,
            });
            path = sanitizePath(about);
          }

          await obsidianService.writeNote(path, finalContent);
          await indexSyncProcessor.queueSingleNote(path, finalContent);

          return existing ? `Updated memory: ${about}` : `Saved: ${about}`;
        } catch (error) {
          return `Error saving memory: ${error.message}`;
        }
      },
    }),

    recall_memory: tool({
      description:
        'Search for relevant memories by meaning. Returns chunk previews with relevance scores. Use read_full_note to get complete content when needed.',
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
            return 'No relevant memories found.';
          }

          let response = `Found ${results.length} relevant memory chunks:\n\n`;
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

          response +=
            '\n_Use read_full_note to get complete content of any note._';
          return response.trim();
        } catch (error) {
          return `Error recalling memories: ${error.message}`;
        }
      },
    }),

    read_full_note: tool({
      description:
        'Fetch the complete content of a note from memory. Use this when you need full context beyond the preview shown in recall_memory results.',
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

    get_surrounding_chunks: tool({
      description:
        'Get chunks before and after a specific chunk for more context. Useful when a recall_memory result mentions a chunk index and you need surrounding context.',
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

    read_memory: tool({
      description: 'Read a specific memory in full. Alias for read_full_note.',
      inputSchema: z.object({
        path: z
          .string()
          .describe("Memory path (e.g., 'People/Luna' without .md)"),
      }),
      execute: async ({ path }) => {
        try {
          const note = await obsidianService.readNote(path);
          if (!note) {
            return `Memory not found: ${path}`;
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
          return `Error reading memory: ${error.message}`;
        }
      },
    }),

    add_to_memory: tool({
      description: 'Add information to an existing memory',
      inputSchema: z.object({
        path: z.string().describe('Memory path'),
        content: z.string().describe('Content to add'),
      }),
      execute: async ({ path, content }) => {
        try {
          const note = await obsidianService.readNote(path);
          if (!note) {
            return `Memory not found: ${path}`;
          }

          const parsed = matter(note.content);
          const today = new Date().toISOString().split('T')[0];

          const newContent = matter.stringify(
            `${parsed.content.trim()}\n\n${content}`,
            { ...parsed.data, 'last-tended': today },
          );

          await obsidianService.writeNote(path, newContent);
          await indexSyncProcessor.queueSingleNote(path, newContent);
          return `Added to: ${path}`;
        } catch (error) {
          return `Error adding to memory: ${error.message}`;
        }
      },
    }),

    forget: tool({
      description: 'Remove a memory',
      inputSchema: z.object({
        path: z.string().describe('Memory path to remove'),
      }),
      execute: async ({ path }) => {
        try {
          await obsidianService.deleteNote(path);
          await qdrantService.deleteNote(path);
          return `Removed: ${path}`;
        } catch (error) {
          return `Error removing memory: ${error.message}`;
        }
      },
    }),

    list_memories: tool({
      description: 'Browse all memories in a folder',
      inputSchema: z.object({
        folder: z.string().optional().describe('Folder path, empty for root'),
      }),
      execute: async ({ folder }) => {
        try {
          const notes = await obsidianService.listNotes(folder);
          if (notes.length === 0) {
            return folder
              ? `No memories found in: ${folder}`
              : 'No memories found.';
          }
          return `Memories${folder ? ` in ${folder}` : ''}:\n${notes.map(n => `- ${n.replace(/\.md$/, '')}`).join('\n')}`;
        } catch (error) {
          return `Error listing memories: ${error.message}`;
        }
      },
    }),
  };
}
