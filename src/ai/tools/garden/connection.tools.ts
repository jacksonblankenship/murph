import { tool } from 'ai';
import matter from 'gray-matter';
import { z } from 'zod';
import { formatObsidianDate } from '../../../common/obsidian-date';
import { MS_PER_DAY, ORPHAN_LIMIT, ORPHAN_MAX_AGE_DAYS } from './constants';
import { createStubsForBrokenLinks, formatStubResult } from './stub-creator';
import type { GardenToolsDependencies } from './types';

/**
 * Creates connection tools for linking and relationship management.
 *
 * Includes: connect, backlinks, orphans
 */
export function createConnectionTools(deps: GardenToolsDependencies) {
  const { vaultService, indexSyncProcessor } = deps;

  return {
    connect: tool({
      description:
        "Append a wikilink connection at the end of a note. Dense linking creates the garden's value. For inline linking (preferred), use update with mode 'replace' on the full note content instead.",
      inputSchema: z.object({
        from: z.string().describe('Source note path'),
        to: z.string().describe('Target note to link to'),
        reason: z
          .string()
          .describe(
            'WHY these concepts relate - one sentence explaining the connection',
          ),
      }),
      execute: async ({ from, to, reason }) => {
        try {
          const note = vaultService.getNote(from);
          if (!note) {
            return `Note not found: ${from}`;
          }

          const tendedAt = formatObsidianDate();
          const toName = to.replace(/\.md$/, '').split('/').pop();

          // Always include reasoning - links should carry meaning
          const linkText = `\n\n${reason} [[${toName}]]`;

          const newContent = matter.stringify(note.body.trim() + linkText, {
            ...note.frontmatter,
            last_tended: tendedAt,
          });

          await vaultService.writeNote(note.path, newContent);
          await indexSyncProcessor.queueSingleNote(note.path, newContent);

          // Auto-create stub seedlings for any broken wikilinks
          const stubResult = await createStubsForBrokenLinks(linkText, deps);

          return `Connected ${from} -> ${toName}${formatStubResult(stubResult)}`;
        } catch (error) {
          return `Error connecting notes: ${error.message}`;
        }
      },
    }),

    backlinks: tool({
      description:
        "See what links TO a note, with context about why. Useful for understanding a concept's place in the garden.",
      inputSchema: z.object({
        path: z.string().describe('Note to find backlinks for'),
      }),
      execute: async ({ path }) => {
        try {
          const normalizedPath = path.replace(/\.md$/, '');
          const backlinkPaths = vaultService.getBacklinks(path);

          if (backlinkPaths.length === 0) {
            return `No notes link to "${normalizedPath}". This note may need more connections.`;
          }

          const pathName = normalizedPath.split('/').pop();
          const backlinks: { path: string; context: string }[] = [];
          const wikilinkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

          for (const blPath of backlinkPaths) {
            const note = vaultService.getNote(blPath);
            if (!note) continue;

            const lines = note.body.split('\n');
            for (const line of lines) {
              let match = wikilinkRegex.exec(line);
              while (match !== null) {
                const linkTarget = match[1];
                if (
                  linkTarget === normalizedPath ||
                  linkTarget === pathName ||
                  linkTarget.endsWith(`/${pathName}`)
                ) {
                  backlinks.push({
                    path: blPath,
                    context: line.trim(),
                  });
                  break;
                }
                match = wikilinkRegex.exec(line);
              }
              wikilinkRegex.lastIndex = 0;
            }
          }

          if (backlinks.length === 0) {
            return `No notes link to "${normalizedPath}". This note may need more connections.`;
          }

          let response = `**Backlinks to "${normalizedPath}" (${backlinks.length}):**\n\n`;
          for (const bl of backlinks) {
            response += `**${bl.path}**\n> ${bl.context}\n\n`;
          }

          return response.trim();
        } catch (error) {
          return `Error finding backlinks: ${error.message}`;
        }
      },
    }),

    orphans: tool({
      description:
        'Find orphaned notes - those with no connections. Orphans should be connected to the garden or removed. New notes (< maxAgeDays) are excluded to give them time to find connections.',
      inputSchema: z.object({
        type: z
          .enum(['no-inbound', 'no-outbound', 'isolated', 'frontier'])
          .optional()
          .default('isolated')
          .describe(
            'Type of orphan: no-inbound (nothing links here), no-outbound (links to nothing), isolated (both), frontier (has outbound but no inbound - new notes reaching out)',
          ),
        maxAgeDays: z
          .number()
          .optional()
          .default(ORPHAN_MAX_AGE_DAYS)
          .describe(
            'Exclude notes planted less than this many days ago. Set to 0 to include all notes.',
          ),
        limit: z
          .number()
          .optional()
          .default(ORPHAN_LIMIT)
          .describe('Max results'),
      }),
      execute: async ({
        type = 'isolated',
        maxAgeDays = ORPHAN_MAX_AGE_DAYS,
        limit = ORPHAN_LIMIT,
      }) => {
        try {
          const notes = vaultService.getAllNotes();
          if (notes.length === 0) {
            return 'No notes in garden.';
          }

          const now = new Date();
          const cutoffDate = new Date(now.getTime() - maxAgeDays * MS_PER_DAY);

          // Find orphans based on type
          const orphans: { path: string; ageDays: number | null }[] = [];

          for (const note of notes) {
            const normalizedPath = note.path.replace(/\.md$/, '');
            const createdDate = note.stat.ctime;

            // Skip notes that are too new (unless maxAgeDays is 0)
            if (maxAgeDays > 0 && createdDate && createdDate > cutoffDate) {
              continue;
            }

            const inboundCount = vaultService.getBacklinks(note.path).length;
            const outboundCount = note.outboundLinks.size;
            const hasInbound = inboundCount > 0;
            const hasOutbound = outboundCount > 0;

            let isOrphan: boolean;
            if (type === 'isolated') {
              isOrphan = !hasInbound && !hasOutbound;
            } else if (type === 'no-inbound') {
              isOrphan = !hasInbound;
            } else if (type === 'no-outbound') {
              isOrphan = !hasOutbound;
            } else {
              // frontier: has outbound but no inbound
              isOrphan = hasOutbound && !hasInbound;
            }

            if (isOrphan) {
              const ageDays = createdDate
                ? Math.floor(
                    (now.getTime() - createdDate.getTime()) / MS_PER_DAY,
                  )
                : null;
              orphans.push({ path: normalizedPath, ageDays });
            }

            if (orphans.length >= limit) break;
          }

          if (orphans.length === 0) {
            const typeLabels: Record<string, string> = {
              isolated: 'completely isolated',
              'no-inbound': 'with no inbound links',
              'no-outbound': 'with no outbound links',
              frontier: 'frontier (outbound only)',
            };
            const ageNote =
              maxAgeDays > 0
                ? ` (excluding notes < ${maxAgeDays} days old)`
                : '';
            return `No ${typeLabels[type]} notes found${ageNote}. The garden is well-connected!`;
          }

          const typeLabels: Record<string, string> = {
            isolated: 'Isolated notes (no connections)',
            'no-inbound': 'Notes with no inbound links (nothing points here)',
            'no-outbound': 'Notes with no outbound links (point to nothing)',
            frontier: 'Frontier notes (reaching out but not yet discovered)',
          };

          let response = `**${typeLabels[type]}:**\n`;
          for (const orphan of orphans) {
            const ageStr =
              orphan.ageDays !== null ? ` (${orphan.ageDays}d old)` : '';
            response += `- ${orphan.path}${ageStr}\n`;
          }

          if (type === 'frontier') {
            response +=
              "\n_These notes are reaching out to others but haven't been discovered yet. They may need backlinks from related notes._";
          } else {
            response +=
              '\n_These notes need connections. Consider linking them to related concepts or removing if obsolete._';
          }

          return response;
        } catch (error) {
          return `Error finding orphans: ${error.message}`;
        }
      },
    }),
  };
}
