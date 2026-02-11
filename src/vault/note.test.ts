import { describe, expect, test } from 'bun:test';
import { Note, type NoteStat } from './note';

const DEFAULT_STAT: NoteStat = {
  ctime: new Date('2024-01-01'),
  mtime: new Date('2024-06-15'),
  size: 256,
};

function createNote(
  path: string,
  content: string,
  stat: NoteStat = DEFAULT_STAT,
): Note {
  return new Note(path, content, stat);
}

describe('Note', () => {
  describe('frontmatter parsing', () => {
    test('parses valid frontmatter with all fields', () => {
      const content = `---
growth_stage: budding
last_tended: "2024-06-15"
summary: A test note
aliases:
  - test
tags:
  - preference
---
Body content here`;

      const note = createNote('Notes/Test.md', content);

      expect(note.frontmatter.growth_stage).toBe('budding');
      expect(note.frontmatter.last_tended).toBe('2024-06-15');
      expect(note.frontmatter.summary).toBe('A test note');
      expect(note.frontmatter.aliases).toEqual(['test']);
      expect(note.frontmatter.tags).toEqual(['preference']);
    });

    test('applies defaults for missing frontmatter fields', () => {
      const content = `---
growth_stage: seedling
---
Body content`;

      const note = createNote('Notes/Test.md', content);

      expect(note.frontmatter.growth_stage).toBe('seedling');
      expect(note.frontmatter.summary).toBe('');
      expect(note.frontmatter.aliases).toEqual([]);
      expect(note.frontmatter.tags).toEqual([]);
    });

    test('handles content without frontmatter', () => {
      const content = 'Just some text without frontmatter';

      const note = createNote('Notes/Test.md', content);

      expect(note.frontmatter.summary).toBe('');
      expect(note.frontmatter.aliases).toEqual([]);
      expect(note.frontmatter.tags).toEqual([]);
      expect(note.body).toContain('Just some text');
    });

    test('preserves extra keys via passthrough', () => {
      const content = `---
growth_stage: seedling
custom_field: hello
another_field: 42
---
Body`;

      const note = createNote('Notes/Test.md', content);

      expect(note.frontmatter.growth_stage).toBe('seedling');
      expect(note.frontmatter['custom_field']).toBe('hello');
      expect(note.frontmatter['another_field']).toBe(42);
    });

    test('handles empty frontmatter block', () => {
      const content = `---
---
Body content`;

      const note = createNote('Notes/Test.md', content);

      expect(note.frontmatter.summary).toBe('');
      expect(note.frontmatter.aliases).toEqual([]);
      expect(note.body).toContain('Body content');
    });
  });

  describe('wikilink extraction', () => {
    test('extracts simple wikilinks', () => {
      const content = `---
---
Links to [[Concept A]] and [[People/Luna]]`;

      const note = createNote('Notes/Test.md', content);

      expect(note.outboundLinks.has('Concept A')).toBe(true);
      expect(note.outboundLinks.has('People/Luna')).toBe(true);
      expect(note.outboundLinks.size).toBe(2);
    });

    test('extracts aliased wikilinks', () => {
      const content = `---
---
Met [[People/Luna|my dog]] today`;

      const note = createNote('Notes/Test.md', content);

      expect(note.outboundLinks.has('People/Luna')).toBe(true);
      expect(note.outboundLinks.size).toBe(1);
    });

    test('deduplicates repeated links', () => {
      const content = `---
---
First [[Concept]] then [[Concept]] again`;

      const note = createNote('Notes/Test.md', content);

      expect(note.outboundLinks.has('Concept')).toBe(true);
      expect(note.outboundLinks.size).toBe(1);
    });

    test('returns empty set for content with no links', () => {
      const content = `---
---
Just plain text without any links`;

      const note = createNote('Notes/Test.md', content);

      expect(note.outboundLinks.size).toBe(0);
    });

    test('handles multiple links on same line', () => {
      const content = `---
---
Relates to [[A]], [[B]], and [[C]]`;

      const note = createNote('Notes/Test.md', content);

      expect(note.outboundLinks.size).toBe(3);
      expect(note.outboundLinks.has('A')).toBe(true);
      expect(note.outboundLinks.has('B')).toBe(true);
      expect(note.outboundLinks.has('C')).toBe(true);
    });
  });

  describe('title computation', () => {
    test('extracts title from simple path', () => {
      const note = createNote('Morning Routine.md', 'content');
      expect(note.title).toBe('Morning Routine');
    });

    test('extracts title from nested path', () => {
      const note = createNote('People/Luna.md', 'content');
      expect(note.title).toBe('Luna');
    });

    test('extracts title from deeply nested path', () => {
      const note = createNote('Projects/Work/Q4 Goals.md', 'content');
      expect(note.title).toBe('Q4 Goals');
    });

    test('handles path without .md extension', () => {
      const note = createNote('Notes/Test', 'content');
      expect(note.title).toBe('Test');
    });
  });

  describe('raw and body content', () => {
    test('raw preserves full content including frontmatter', () => {
      const content = `---
growth_stage: seedling
---
Body text`;

      const note = createNote('Notes/Test.md', content);

      expect(note.raw).toBe(content);
      expect(note.body).toContain('Body text');
      expect(note.body).not.toContain('growth_stage');
    });

    test('handles empty content', () => {
      const note = createNote('Notes/Empty.md', '');

      expect(note.raw).toBe('');
      expect(note.body).toBe('');
      expect(note.outboundLinks.size).toBe(0);
    });

    test('handles whitespace-only content', () => {
      const note = createNote('Notes/Blank.md', '   \n  \n   ');

      expect(note.body).toBeTruthy();
      expect(note.outboundLinks.size).toBe(0);
    });
  });

  describe('stat', () => {
    test('stores stat metadata', () => {
      const stat: NoteStat = {
        ctime: new Date('2024-01-15'),
        mtime: new Date('2024-06-20'),
        size: 512,
      };

      const note = createNote('Notes/Test.md', 'content', stat);

      expect(note.stat.ctime).toEqual(new Date('2024-01-15'));
      expect(note.stat.mtime).toEqual(new Date('2024-06-20'));
      expect(note.stat.size).toBe(512);
    });
  });
});
