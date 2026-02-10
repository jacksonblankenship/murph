import { tool } from 'ai';
import matter from 'gray-matter';
import { z } from 'zod';
import { formatObsidianDate } from '../../../common/obsidian-date';
import {
  DUPLICATE_CHECK_LIMIT,
  PERCENT_DECIMALS_ROUNDED,
  PERCENT_MULTIPLIER,
  SIMILARITY_HIGH,
  SIMILARITY_LOW,
} from './constants';

import type { GardenToolsDependencies } from './types';
import { ensureMdExtension, GROWTH_STAGE_ICONS, sanitizePath } from './utils';

/**
 * Creates core garden tools for basic note operations.
 *
 * Includes: plant, update, read, browse, uproot
 */
export function createCoreTools(deps: GardenToolsDependencies) {
  const {
    obsidianService,
    embeddingService,
    qdrantService,
    indexSyncProcessor,
  } = deps;

  return {
    plant: tool({
      description:
        'Plant a new seedling in the garden. Each note should be atomic (one concept) and concept-oriented (organized by idea, not source). Automatically checks for similar notes to prevent duplicates.',
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
            'Optional loose grouping: "People", "Concepts", "Places", "Projects". Links matter more than folders for organization.',
          ),
      }),
      execute: async ({ title, content, folder }) => {
        try {
          const sanitizedTitle = sanitizePath(title);
          const path = folder
            ? `${sanitizePath(folder)}/${sanitizedTitle}`
            : sanitizedTitle;

          // Check if note already exists at this exact path
          const existing = await obsidianService.readNote(path);
          if (existing) {
            return `Note already exists at "${path}". Use update with mode: 'append' to add to it instead.`;
          }

          // Check for semantically similar notes to prevent duplicates
          const embedding = await embeddingService.embed(`${title} ${content}`);
          const similar = await qdrantService.searchSimilarChunks(
            embedding,
            DUPLICATE_CHECK_LIMIT,
          );
          const highMatch = similar.find(r => r.score > SIMILARITY_HIGH);

          // High matches get a warning but don't block creation — capture first, organize later
          let duplicateWarning = '';
          if (highMatch) {
            const matchPath = highMatch.path.replace(/\.md$/, '');
            duplicateWarning = `\n\n⚠️ Heads up: "${matchPath}" is ${(highMatch.score * PERCENT_MULTIPLIER).toFixed(PERCENT_DECIMALS_ROUNDED)}% similar. The garden tender may merge these later, or use search_similar to compare them.`;
          }

          // Don't add H1 header - Obsidian gets title from filename
          const finalContent = matter.stringify(content, {
            growth_stage: 'seedling',
            last_tended: formatObsidianDate(),
            summary: '',
            aliases: [],
            tags: [],
          });

          await obsidianService.writeNote(path, finalContent);
          await indexSyncProcessor.queueSingleNote(path, finalContent);

          // Include moderate matches as suggestions for linking
          const moderateMatches = similar.filter(
            r => r.score > SIMILARITY_LOW && r.score <= SIMILARITY_HIGH,
          );
          let response = `Planted seedling: ${path}`;

          if (moderateMatches.length > 0) {
            response += '\n\n**Consider linking to:**\n';
            for (const match of moderateMatches) {
              response += `- [[${match.path.replace(/\.md$/, '')}]] (${(match.score * PERCENT_MULTIPLIER).toFixed(PERCENT_DECIMALS_ROUNDED)}% related)\n`;
            }
          }

          return response + duplicateWarning;
        } catch (error) {
          return `Error planting note: ${error.message}`;
        }
      },
    }),

    update: tool({
      description:
        'Update an existing note. Use mode "append" to add new content at the end, or mode "replace" to completely rewrite the note content. Preserves frontmatter and updates last-tended timestamp.',
      inputSchema: z.object({
        path: z
          .string()
          .describe('Note path (e.g., "People/Luna", "Morning Routine")'),
        content: z
          .string()
          .describe(
            'Content to add (append mode) or new complete content (replace mode). Use [[wikilinks]] for connections.',
          ),
        mode: z
          .enum(['append', 'replace'])
          .describe(
            'append: add content to end of note. replace: overwrite entire note content.',
          ),
      }),
      execute: async ({ path, content, mode }) => {
        try {
          const note = await obsidianService.readNote(path);
          if (!note) {
            return `Note not found: ${path}. Use plant to create it first.`;
          }

          const parsed = matter(note.content);
          const tendedAt = formatObsidianDate();

          let newContent: string;
          if (mode === 'append') {
            newContent = matter.stringify(
              `${parsed.content.trim()}\n\n${content}`,
              { ...parsed.data, last_tended: tendedAt },
            );
          } else {
            newContent = matter.stringify(content, {
              ...parsed.data,
              last_tended: tendedAt,
            });
          }

          await obsidianService.writeNote(path, newContent);
          await indexSyncProcessor.queueSingleNote(
            ensureMdExtension(path),
            newContent,
          );

          const action = mode === 'append' ? 'Tended' : 'Rewrote';
          return `${action}: ${path}`;
        } catch (error) {
          return `Error updating note: ${error.message}`;
        }
      },
    }),

    read: tool({
      description:
        'Read the complete content of a note. Optionally include backlinks to see what links here.',
      inputSchema: z.object({
        path: z
          .string()
          .describe("Note path (e.g., 'People/Luna' or 'People/Luna.md')"),
        includeBacklinks: z
          .boolean()
          .optional()
          .default(false)
          .describe('Include list of notes that link here'),
      }),
      execute: async ({ path, includeBacklinks = false }) => {
        try {
          const note = await obsidianService.readNote(path);
          if (!note) {
            return `Note not found: ${path}`;
          }

          const parsed = matter(note.content);
          const icon =
            GROWTH_STAGE_ICONS[parsed.data.growth_stage as string] || '';

          let response = `**${path}** ${icon}\n\n${parsed.content}`;

          if (includeBacklinks) {
            const normalizedPath = path.replace(/\.md$/, '');
            const pathName = normalizedPath.split('/').pop();
            const notes = await obsidianService.getAllNotesWithContent();
            const wikilinkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
            const backlinks: string[] = [];

            for (const n of notes) {
              if (n.path.replace(/\.md$/, '') === normalizedPath) continue;

              const noteParsed = matter(n.content);
              let match = wikilinkRegex.exec(noteParsed.content);
              while (match !== null) {
                const linkTarget = match[1];
                if (
                  linkTarget === normalizedPath ||
                  linkTarget === pathName ||
                  linkTarget.endsWith(`/${pathName}`)
                ) {
                  backlinks.push(n.path.replace(/\.md$/, ''));
                  break;
                }
                match = wikilinkRegex.exec(noteParsed.content);
              }
            }

            if (backlinks.length > 0) {
              response += `\n\n---\n**Backlinks (${backlinks.length}):**\n`;
              for (const bl of backlinks) {
                response += `- [[${bl}]]\n`;
              }
            } else {
              response += '\n\n---\n_No backlinks found._';
            }
          }

          return response;
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
        growth_stage: z
          .enum(['seedling', 'budding', 'evergreen'])
          .optional()
          .describe('Filter by growth stage'),
      }),
      execute: async ({ folder, growth_stage }) => {
        try {
          const notes = await obsidianService.listNotes(folder);
          if (notes.length === 0) {
            return folder ? `No notes found in: ${folder}` : 'No notes found.';
          }

          // If growth_stage filter is specified, we need to check each note
          if (growth_stage) {
            const filtered: string[] = [];
            for (const notePath of notes) {
              const note = await obsidianService.readNote(notePath);
              if (note) {
                const parsed = matter(note.content);
                if (parsed.data.growth_stage === growth_stage) {
                  filtered.push(notePath);
                }
              }
            }

            if (filtered.length === 0) {
              return `No ${growth_stage} notes found${folder ? ` in ${folder}` : ''}.`;
            }

            const icon = GROWTH_STAGE_ICONS[growth_stage];

            return `${icon} ${growth_stage} notes${folder ? ` in ${folder}` : ''}:\n${filtered.map(n => `- ${n.replace(/\.md$/, '')}`).join('\n')}`;
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
  };
}
