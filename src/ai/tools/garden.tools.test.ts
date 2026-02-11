import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Note } from '../../vault';
import { createGardenTools } from './garden';

/** Helper to create a mock Note instance from path and raw content. */
function createMockNote(
  path: string,
  content: string,
  stat?: Partial<{ ctime: Date; mtime: Date; size: number }>,
): Note {
  const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;
  return new Note(normalizedPath, content, {
    ctime: stat?.ctime ?? new Date('2024-01-01'),
    mtime: stat?.mtime ?? new Date('2024-01-01'),
    size: stat?.size ?? content.length,
  });
}

describe('createGardenTools', () => {
  let mockVaultService: {
    getNote: ReturnType<typeof mock>;
    writeNote: ReturnType<typeof mock>;
    deleteNote: ReturnType<typeof mock>;
    listNotes: ReturnType<typeof mock>;
    getAllNotes: ReturnType<typeof mock>;
    getBacklinks: ReturnType<typeof mock>;
  };
  let mockEmbeddingService: { embed: ReturnType<typeof mock> };
  let mockQdrantService: {
    searchSimilarChunks: ReturnType<typeof mock>;
    searchSimilar: ReturnType<typeof mock>;
    getSurroundingChunks: ReturnType<typeof mock>;
    deleteNote: ReturnType<typeof mock>;
  };
  let mockIndexSyncProcessor: { queueSingleNote: ReturnType<typeof mock> };
  let tools: ReturnType<typeof createGardenTools>;

  beforeEach(() => {
    mockVaultService = {
      getNote: mock(() => null),
      writeNote: mock(() => Promise.resolve()),
      deleteNote: mock(() => Promise.resolve()),
      listNotes: mock(() => []),
      getAllNotes: mock(() => []),
      getBacklinks: mock(() => []),
    };

    mockEmbeddingService = {
      embed: mock(() => Promise.resolve([0.1, 0.2, 0.3])),
    };

    mockQdrantService = {
      searchSimilarChunks: mock(() => Promise.resolve([])),
      searchSimilar: mock(() => Promise.resolve([])),
      getSurroundingChunks: mock(() => Promise.resolve([])),
      deleteNote: mock(() => Promise.resolve()),
    };

    mockIndexSyncProcessor = {
      queueSingleNote: mock(() => Promise.resolve()),
    };

    tools = createGardenTools({
      vaultService: mockVaultService as never,
      embeddingService: mockEmbeddingService as never,
      qdrantService: mockQdrantService as never,
      indexSyncProcessor: mockIndexSyncProcessor as never,
    });
  });

  describe('wander', () => {
    test('returns message when no notes exist', async () => {
      mockVaultService.getAllNotes = mock(() => []);

      const result = await tools.wander.execute(
        { excludeRecentDays: 7, limit: 3 },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toBe('No notes in garden to wander through.');
    });

    test('filters by growth stage', async () => {
      mockVaultService.getAllNotes = mock(() => [
        createMockNote(
          'Notes/Seedling',
          '---\ngrowth_stage: seedling\nlast_tended: 2024-01-01T00:00:00.000Z\n---\nA seedling',
        ),
        createMockNote(
          'Notes/Evergreen',
          '---\ngrowth_stage: evergreen\nlast_tended: 2024-01-01T00:00:00.000Z\n---\nAn evergreen',
        ),
      ]);

      const result = await tools.wander.execute(
        { growth_stage: 'evergreen', excludeRecentDays: 7, limit: 3 },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Notes/Evergreen');
      expect(result).not.toContain('Notes/Seedling');
    });

    test('excludes recently tended notes', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 1); // Yesterday

      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 14); // Two weeks ago

      mockVaultService.getAllNotes = mock(() => [
        createMockNote(
          'Notes/Recent',
          `---\ngrowth_stage: seedling\nlast_tended: ${recentDate.toISOString()}\n---\nRecent note`,
        ),
        createMockNote(
          'Notes/Old',
          `---\ngrowth_stage: seedling\nlast_tended: ${oldDate.toISOString()}\n---\nOld note`,
        ),
      ]);

      const result = await tools.wander.execute(
        { excludeRecentDays: 7, limit: 3 },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Notes/Old');
      expect(result).not.toContain('Notes/Recent');
    });

    test('respects limit parameter', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 14);

      mockVaultService.getAllNotes = mock(() => [
        createMockNote(
          'Notes/Note1',
          `---\ngrowth_stage: seedling\nlast_tended: ${oldDate.toISOString()}\n---\nNote 1`,
        ),
        createMockNote(
          'Notes/Note2',
          `---\ngrowth_stage: seedling\nlast_tended: ${oldDate.toISOString()}\n---\nNote 2`,
        ),
        createMockNote(
          'Notes/Note3',
          `---\ngrowth_stage: seedling\nlast_tended: ${oldDate.toISOString()}\n---\nNote 3`,
        ),
      ]);

      const result = await tools.wander.execute(
        { excludeRecentDays: 7, limit: 1 },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      // Should only have one note in the result
      const resultStr = result as string;
      const noteCount = (resultStr.match(/\*\*Notes\//g) || []).length;
      expect(noteCount).toBe(1);
    });
  });

  describe('backlinks', () => {
    test('returns message when no backlinks exist', async () => {
      mockVaultService.getBacklinks = mock(() => []);

      const result = await tools.backlinks.execute(
        { path: 'Notes/Target' },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('No notes link to "Notes/Target"');
    });

    test('finds notes that link to target', async () => {
      mockVaultService.getBacklinks = mock(() => ['Notes/Linking.md']);
      mockVaultService.getNote = mock((path: string) => {
        if (path === 'Notes/Linking.md') {
          return createMockNote(
            'Notes/Linking',
            '---\ngrowth_stage: seedling\n---\nThis references [[Target]] here',
          );
        }
        return null;
      });

      const result = await tools.backlinks.execute(
        { path: 'Notes/Target' },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Backlinks to "Notes/Target"');
      expect(result).toContain('Notes/Linking');
      expect(result).toContain('This references [[Target]] here');
    });

    test('handles full path links', async () => {
      mockVaultService.getBacklinks = mock(() => ['Notes/Linking.md']);
      mockVaultService.getNote = mock((path: string) => {
        if (path === 'Notes/Linking.md') {
          return createMockNote(
            'Notes/Linking',
            '---\ngrowth_stage: seedling\n---\nMet [[People/Luna]] today',
          );
        }
        return null;
      });

      const result = await tools.backlinks.execute(
        { path: 'People/Luna' },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Notes/Linking');
      expect(result).toContain('Met [[People/Luna]] today');
    });

    test('handles multiple backlinks', async () => {
      mockVaultService.getBacklinks = mock(() => [
        'Notes/First.md',
        'Notes/Second.md',
      ]);
      mockVaultService.getNote = mock((path: string) => {
        if (path === 'Notes/First.md') {
          return createMockNote(
            'Notes/First',
            '---\ngrowth_stage: seedling\n---\nFirst link to [[Target]]',
          );
        }
        if (path === 'Notes/Second.md') {
          return createMockNote(
            'Notes/Second',
            '---\ngrowth_stage: seedling\n---\nSecond reference to [[Target]]',
          );
        }
        return null;
      });

      const result = await tools.backlinks.execute(
        { path: 'Notes/Target' },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('(2)');
      expect(result).toContain('Notes/First');
      expect(result).toContain('Notes/Second');
    });
  });

  describe('read with includeBacklinks', () => {
    test('returns content without backlinks by default', async () => {
      mockVaultService.getNote = mock(() =>
        createMockNote(
          'Notes/Test',
          '---\ngrowth_stage: seedling\n---\nTest content',
        ),
      );

      const result = await tools.read.execute(
        { path: 'Notes/Test', includeBacklinks: false },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Test content');
      expect(result).not.toContain('Backlinks');
    });

    test('includes backlinks when requested', async () => {
      mockVaultService.getNote = mock(() =>
        createMockNote(
          'Notes/Target',
          '---\ngrowth_stage: seedling\n---\nTarget content',
        ),
      );
      mockVaultService.getBacklinks = mock(() => ['Notes/Linking.md']);

      const result = await tools.read.execute(
        { path: 'Notes/Target', includeBacklinks: true },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Target content');
      expect(result).toContain('Backlinks (1)');
      expect(result).toContain('[[Notes/Linking.md]]');
    });

    test('shows no backlinks message when none exist', async () => {
      mockVaultService.getNote = mock(() =>
        createMockNote(
          'Notes/Lonely',
          '---\ngrowth_stage: seedling\n---\nLonely content',
        ),
      );
      mockVaultService.getBacklinks = mock(() => []);

      const result = await tools.read.execute(
        { path: 'Notes/Lonely', includeBacklinks: true },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Lonely content');
      expect(result).toContain('No backlinks found');
    });
  });

  describe('update with replace mode', () => {
    test('replaces note content preserving frontmatter', async () => {
      mockVaultService.getNote = mock(() =>
        createMockNote(
          'Notes/Test',
          '---\ngrowth_stage: budding\n---\nOld content',
        ),
      );

      const result = await tools.update.execute(
        {
          path: 'Notes/Test',
          content: 'New improved content with [[links]]',
          mode: 'replace',
        },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Rewrote');
      expect(result).toContain('Notes/Test');
      expect(mockVaultService.writeNote).toHaveBeenCalled();
      expect(mockIndexSyncProcessor.queueSingleNote).toHaveBeenCalled();
    });

    test('returns error for non-existent note', async () => {
      mockVaultService.getNote = mock(() => null);

      const result = await tools.update.execute(
        {
          path: 'Notes/Missing',
          content: 'New content',
          mode: 'replace',
        },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Note not found');
    });
  });

  describe('merge', () => {
    test('merges source into target and deletes source', async () => {
      mockVaultService.getNote = mock((path: string) => {
        if (path.includes('Source')) {
          return createMockNote(
            'Notes/Source',
            '---\ngrowth_stage: seedling\n---\nSource content',
          );
        }
        if (path.includes('Target')) {
          return createMockNote(
            'Notes/Target',
            '---\ngrowth_stage: budding\n---\nTarget content',
          );
        }
        return null;
      });

      mockVaultService.getAllNotes = mock(() => []);

      const result = await tools.merge.execute(
        {
          sourcePath: 'Notes/Source',
          targetPath: 'Notes/Target',
          mergedContent: 'Combined source and target content',
          reason: 'Duplicate concepts',
        },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Merged "Notes/Source" into "Notes/Target"');
      expect(mockVaultService.deleteNote).toHaveBeenCalledWith('Notes/Source');
      expect(mockQdrantService.deleteNote).toHaveBeenCalledWith('Notes/Source');
    });

    test('returns error when source not found', async () => {
      mockVaultService.getNote = mock(() => null);

      const result = await tools.merge.execute(
        {
          sourcePath: 'Notes/Missing',
          targetPath: 'Notes/Target',
          mergedContent: 'Content',
          reason: 'Testing',
        },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Source note not found');
    });
  });

  describe('split', () => {
    test('creates new notes from split', async () => {
      mockVaultService.getNote = mock(() =>
        createMockNote(
          'Notes/BigNote',
          '---\ngrowth_stage: seedling\n---\nLots of content here',
        ),
      );

      const result = await tools.split.execute(
        {
          originalPath: 'Notes/BigNote',
          newNotes: [
            {
              title: 'Concept A',
              content: 'First concept',
              folder: 'Concepts',
            },
            { title: 'Concept B', content: 'Second concept' },
          ],
          deleteOriginal: true,
          reason: 'Non-atomic note covering multiple concepts',
        },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Split and deleted');
      expect(result).toContain('Concepts/Concept A');
      expect(result).toContain('Concept B');
      expect(mockVaultService.writeNote).toHaveBeenCalledTimes(2);
      expect(mockVaultService.deleteNote).toHaveBeenCalled();
    });

    test('keeps original when deleteOriginal is false', async () => {
      mockVaultService.getNote = mock(() =>
        createMockNote(
          'Notes/HubNote',
          '---\ngrowth_stage: seedling\n---\nHub content',
        ),
      );

      const result = await tools.split.execute(
        {
          originalPath: 'Notes/HubNote',
          newNotes: [{ title: 'Detail', content: 'Detail content' }],
          deleteOriginal: false,
          updatedOriginal: 'Updated hub linking to [[Detail]]',
          reason: 'Extracting details',
        },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Split "Notes/HubNote"');
      expect(mockVaultService.deleteNote).not.toHaveBeenCalled();
    });
  });

  describe('promote', () => {
    test('promotes seedling to budding', async () => {
      mockVaultService.getNote = mock(() =>
        createMockNote(
          'Notes/Growing',
          '---\ngrowth_stage: seedling\n---\nContent',
        ),
      );

      const result = await tools.promote.execute(
        {
          path: 'Notes/Growing',
          newMaturity: 'budding',
          reason: 'Has 3+ connections and clear core idea',
        },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Promoted');
      expect(result).toContain('seedling');
      expect(result).toContain('budding');
    });

    test('rejects demotion', async () => {
      mockVaultService.getNote = mock(() =>
        createMockNote(
          'Notes/Mature',
          '---\ngrowth_stage: evergreen\n---\nContent',
        ),
      );

      const result = await tools.promote.execute(
        {
          path: 'Notes/Mature',
          newMaturity: 'budding',
          reason: 'Testing',
        },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Cannot promote');
      expect(result).toContain('already evergreen');
    });
  });

  describe('search_similar', () => {
    test('returns similar notes above threshold', async () => {
      mockQdrantService.searchSimilarChunks = mock(() =>
        Promise.resolve([
          { path: 'Notes/Similar1.md', score: 0.95, title: 'Similar 1' },
          { path: 'Notes/Similar2.md', score: 0.82, title: 'Similar 2' },
          { path: 'Notes/Weak.md', score: 0.5, title: 'Weak' },
        ]),
      );

      const result = await tools.search_similar.execute(
        { query: 'test topic', threshold: 0.7, limit: 5, showMergeHints: true },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Notes/Similar1');
      expect(result).toContain('Notes/Similar2');
      expect(result).not.toContain('Notes/Weak');
      expect(result).toContain('likely duplicate');
    });

    test('returns message when no similar notes found', async () => {
      mockQdrantService.searchSimilarChunks = mock(() =>
        Promise.resolve([{ path: 'Notes/Low.md', score: 0.3, title: 'Low' }]),
      );

      const result = await tools.search_similar.execute(
        {
          query: 'unique topic',
          threshold: 0.7,
          limit: 5,
          showMergeHints: true,
        },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('No notes found with similarity');
    });
  });

  describe('orphans with age filter', () => {
    test('excludes notes younger than maxAgeDays', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 3); // 3 days ago

      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 14); // 14 days ago

      mockVaultService.getAllNotes = mock(() => [
        createMockNote(
          'Notes/Recent',
          '---\ngrowth_stage: seedling\n---\nRecent note',
          { ctime: recentDate },
        ),
        createMockNote(
          'Notes/Old',
          '---\ngrowth_stage: seedling\n---\nOld note',
          { ctime: oldDate },
        ),
      ]);

      mockVaultService.getBacklinks = mock(() => []);

      const result = await tools.orphans.execute(
        { type: 'isolated', maxAgeDays: 7, limit: 10 },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Notes/Old');
      expect(result).not.toContain('Notes/Recent');
    });

    test('includes all notes when maxAgeDays is 0', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 1); // Yesterday

      mockVaultService.getAllNotes = mock(() => [
        createMockNote(
          'Notes/Recent',
          '---\ngrowth_stage: seedling\n---\nRecent note',
          { ctime: recentDate },
        ),
      ]);

      mockVaultService.getBacklinks = mock(() => []);

      const result = await tools.orphans.execute(
        { type: 'isolated', maxAgeDays: 0, limit: 10 },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Notes/Recent');
    });

    test('finds frontier notes (outbound only)', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 14);

      mockVaultService.getAllNotes = mock(() => [
        createMockNote(
          'Notes/Frontier',
          '---\ngrowth_stage: seedling\n---\nLinks to [[Other]]',
          { ctime: oldDate },
        ),
        createMockNote(
          'Notes/Other',
          '---\ngrowth_stage: seedling\n---\nNo links',
          { ctime: oldDate },
        ),
      ]);

      mockVaultService.getBacklinks = mock(() => []);

      const result = await tools.orphans.execute(
        { type: 'frontier', maxAgeDays: 7, limit: 10 },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Frontier notes');
      expect(result).toContain('Notes/Frontier');
    });
  });

  describe('moc_candidates', () => {
    test('finds notes with 5+ inbound links', async () => {
      const importantNote = createMockNote(
        'Concepts/Important',
        '---\ngrowth_stage: evergreen\n---\nImportant concept',
      );

      mockVaultService.getAllNotes = mock(() => [
        importantNote,
        createMockNote('Notes/A', '---\n---\nLinks to [[Important]]'),
        createMockNote('Notes/B', '---\n---\nAlso links to [[Important]]'),
        createMockNote('Notes/C', '---\n---\nReferences [[Important]]'),
        createMockNote('Notes/D', '---\n---\nMentions [[Important]]'),
        createMockNote('Notes/E', '---\n---\nSees [[Important]]'),
      ]);

      mockVaultService.getBacklinks = mock((path: string) => {
        if (path === 'Concepts/Important.md') {
          return [
            'Notes/A.md',
            'Notes/B.md',
            'Notes/C.md',
            'Notes/D.md',
            'Notes/E.md',
          ];
        }
        return [];
      });

      const result = await tools.moc_candidates.execute(
        { minInboundLinks: 5, limit: 10 },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('MOC Candidates');
      expect(result).toContain('Concepts/Important');
      expect(result).toContain('5 inbound');
    });

    test('excludes existing MOCs by title', async () => {
      mockVaultService.getAllNotes = mock(() => [
        createMockNote(
          'Maps/Existing MOC',
          '---\ngrowth_stage: seedling\n---\nAlready an MOC',
        ),
      ]);

      mockVaultService.getBacklinks = mock(() => [
        'Notes/A.md',
        'Notes/B.md',
        'Notes/C.md',
        'Notes/D.md',
        'Notes/E.md',
      ]);

      const result = await tools.moc_candidates.execute(
        { minInboundLinks: 5, limit: 10 },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('No notes found');
    });
  });

  describe('create_moc', () => {
    test('creates MOC with linked notes', async () => {
      mockVaultService.getNote = mock(() => null);

      const result = await tools.create_moc.execute(
        {
          title: 'Productivity MOC',
          relatedNotes: ['Notes/Focus', 'Notes/Routine', 'Notes/Energy'],
          introduction: 'Everything about being productive',
          folder: 'Maps',
        },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Created MOC "Maps/Productivity MOC"');
      expect(result).toContain('3 linked notes');
      expect(mockVaultService.writeNote).toHaveBeenCalled();
    });

    test('rejects if MOC already exists', async () => {
      mockVaultService.getNote = mock(() =>
        createMockNote(
          'Maps/Existing',
          '---\ngrowth_stage: seedling\n---\nExisting',
        ),
      );

      const result = await tools.create_moc.execute(
        {
          title: 'Existing',
          relatedNotes: ['Notes/A'],
          folder: 'Maps',
        },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('MOC already exists');
    });
  });

  describe('disconnect', () => {
    test('removes link from note', async () => {
      mockVaultService.getNote = mock(() =>
        createMockNote(
          'Notes/Source',
          '---\ngrowth_stage: seedling\n---\nThis links to [[Target]] here',
        ),
      );

      const result = await tools.disconnect.execute(
        { from: 'Notes/Source', to: 'Notes/Target' },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Removed link to [[Target]]');
      expect(mockVaultService.writeNote).toHaveBeenCalled();
    });

    test('returns message when link not found', async () => {
      mockVaultService.getNote = mock(() =>
        createMockNote(
          'Notes/Source',
          '---\ngrowth_stage: seedling\n---\nNo links here',
        ),
      );

      const result = await tools.disconnect.execute(
        { from: 'Notes/Source', to: 'Notes/Missing' },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('No link to "Notes/Missing" found');
    });
  });

  describe('broken_links', () => {
    test('finds broken wikilinks', async () => {
      mockVaultService.getAllNotes = mock(() => [
        createMockNote(
          'Notes/WithBroken',
          '---\ngrowth_stage: seedling\n---\nLinks to [[NonExistent]] here',
        ),
        createMockNote(
          'Notes/Valid',
          '---\ngrowth_stage: seedling\n---\nLinks to [[WithBroken]]',
        ),
      ]);

      const result = await tools.broken_links.execute(
        { limit: 20 },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('Broken Links');
      expect(result).toContain('NonExistent');
      expect(result).toContain('Notes/WithBroken');
    });

    test('returns success message when no broken links', async () => {
      mockVaultService.getAllNotes = mock(() => [
        createMockNote('Notes/A', '---\n---\nLinks to [[B]]'),
        createMockNote('Notes/B', '---\n---\nLinks to [[A]]'),
      ]);

      const result = await tools.broken_links.execute(
        { limit: 20 },
        { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
      );

      expect(result).toContain('No broken links found');
    });
  });
});
