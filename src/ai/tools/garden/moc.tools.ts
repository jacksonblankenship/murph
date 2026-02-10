import { tool } from 'ai';
import matter from 'gray-matter';
import { z } from 'zod';
import { formatObsidianDate } from '../../../common/obsidian-date';
import {
  MOC_MIN_INBOUND_LINKS,
  ORPHAN_LIMIT,
  TOP_LINKERS_PREVIEW,
} from './constants';
import type { GardenToolsDependencies } from './types';
import { sanitizePath } from './utils';

/**
 * Creates MOC (Map of Content) tools for navigational hubs.
 *
 * Includes: moc_candidates, create_moc
 */
export function createMocTools(deps: GardenToolsDependencies) {
  const { obsidianService, indexSyncProcessor } = deps;

  return {
    moc_candidates: tool({
      description:
        'Find notes that are good candidates for a Map of Content (MOC). These are notes with 5+ inbound links that could serve as navigational hubs.',
      inputSchema: z.object({
        minInboundLinks: z
          .number()
          .optional()
          .default(MOC_MIN_INBOUND_LINKS)
          .describe('Minimum inbound links to qualify as MOC candidate'),
        limit: z
          .number()
          .optional()
          .default(ORPHAN_LIMIT)
          .describe('Max results'),
      }),
      execute: async ({
        minInboundLinks = MOC_MIN_INBOUND_LINKS,
        limit = ORPHAN_LIMIT,
      }) => {
        try {
          const notes = await obsidianService.getAllNotesWithContent();
          if (notes.length === 0) {
            return 'No notes in garden.';
          }

          // Build inbound link counts
          const wikilinkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
          const inboundLinks = new Map<string, string[]>();
          const validPaths = new Set<string>();

          // Initialize
          for (const note of notes) {
            const normalizedPath = note.path.replace(/\.md$/, '');
            validPaths.add(normalizedPath);
            inboundLinks.set(normalizedPath, []);
          }

          // Count inbound links
          for (const note of notes) {
            const normalizedPath = note.path.replace(/\.md$/, '');
            const parsed = matter(note.content);

            let match = wikilinkRegex.exec(parsed.content);
            while (match !== null) {
              const linkTarget = match[1];
              const targetPath = [...validPaths].find(
                p => p === linkTarget || p.endsWith(`/${linkTarget}`),
              );
              if (targetPath) {
                inboundLinks.get(targetPath)?.push(normalizedPath);
              }
              match = wikilinkRegex.exec(parsed.content);
            }
          }

          // Find candidates (exclude existing MOCs by title)
          const candidates: {
            path: string;
            inboundCount: number;
            topLinkers: string[];
          }[] = [];
          for (const [path, linkers] of inboundLinks) {
            // Skip notes whose title contains "MOC" (case-insensitive)
            const title = path.split('/').pop() || '';
            if (/\bmoc\b/i.test(title)) continue;

            if (linkers.length >= minInboundLinks) {
              candidates.push({
                path,
                inboundCount: linkers.length,
                topLinkers: linkers.slice(0, TOP_LINKERS_PREVIEW),
              });
            }
          }

          // Sort by inbound count descending
          candidates.sort((a, b) => b.inboundCount - a.inboundCount);
          const limited = candidates.slice(0, limit);

          if (limited.length === 0) {
            return `No notes found with ${minInboundLinks}+ inbound links. The garden may need more cross-linking.`;
          }

          let response = `**MOC Candidates (${minInboundLinks}+ inbound links):**\n\n`;
          for (const candidate of limited) {
            response += `**${candidate.path}** (${candidate.inboundCount} inbound)\n`;
            response += `  Linked from: ${candidate.topLinkers.map(p => `[[${p.split('/').pop()}]]`).join(', ')}`;
            if (candidate.inboundCount > TOP_LINKERS_PREVIEW) {
              response += ` +${candidate.inboundCount - TOP_LINKERS_PREVIEW} more`;
            }
            response += '\n\n';
          }

          response +=
            '_These notes are heavily referenced and could become Maps of Content to help navigate related topics._';
          return response.trim();
        } catch (error) {
          return `Error finding MOC candidates: ${error.message}`;
        }
      },
    }),

    create_moc: tool({
      description:
        'Create a Map of Content (MOC) - a navigational hub note that links to related notes around a theme.',
      inputSchema: z.object({
        title: z
          .string()
          .describe('Title for the MOC (e.g., "Productivity MOC")'),
        relatedNotes: z
          .array(z.string())
          .describe('Paths of notes to include in this MOC'),
        introduction: z
          .string()
          .optional()
          .describe(
            'Optional brief introduction explaining what this MOC covers',
          ),
        folder: z
          .string()
          .optional()
          .describe('Folder for the MOC (e.g., "Maps")'),
      }),
      execute: async ({ title, relatedNotes, introduction, folder }) => {
        try {
          const sanitizedTitle = sanitizePath(title);
          const mocPath = folder
            ? `${sanitizePath(folder)}/${sanitizedTitle}`
            : sanitizedTitle;

          // Check if already exists
          const existing = await obsidianService.readNote(mocPath);
          if (existing) {
            return `MOC already exists at "${mocPath}". Use update to modify it.`;
          }

          // Build MOC content
          let content = '';
          if (introduction) {
            content += `${introduction}\n\n`;
          }

          content += '## Notes\n\n';
          for (const notePath of relatedNotes) {
            const noteName = notePath.replace(/\.md$/, '').split('/').pop();
            content += `- [[${noteName}]]\n`;
          }

          const mocSummary = `Map of Content for ${title}: navigational hub linking related notes`;

          const finalContent = matter.stringify(content, {
            growth_stage: 'seedling',
            last_tended: formatObsidianDate(),
            summary: mocSummary,
            aliases: [],
            tags: [],
          });

          await obsidianService.writeNote(mocPath, finalContent);
          await indexSyncProcessor.queueSingleNote(
            `${mocPath}.md`,
            finalContent,
          );

          return `Created MOC "${mocPath}" with ${relatedNotes.length} linked notes.`;
        } catch (error) {
          return `Error creating MOC: ${error.message}`;
        }
      },
    }),
  };
}
