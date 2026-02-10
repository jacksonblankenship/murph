import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/pino-logger.mock';
import { ChunkingService } from './chunking.service';

describe('ChunkingService', () => {
  let service: ChunkingService;
  let mockConfigService: { get: ReturnType<typeof mock> };

  beforeEach(() => {
    mockConfigService = {
      get: mock((key: string) => {
        if (key === 'vector.chunkSize') return 500;
        if (key === 'vector.chunkOverlap') return 50;
        return undefined;
      }),
    };

    service = new ChunkingService(
      createMockLogger(),
      mockConfigService as never,
    );
  });

  describe('chunkMarkdown', () => {
    test('returns empty array for empty content', () => {
      const result = service.chunkMarkdown('');
      expect(result).toEqual([]);
    });

    test('returns empty array for whitespace-only content', () => {
      const result = service.chunkMarkdown('   \n\n   ');
      expect(result).toEqual([]);
    });

    test('returns empty array for frontmatter-only content', () => {
      const content = `---
title: Test
tags: [test]
---
`;
      const result = service.chunkMarkdown(content);
      expect(result).toEqual([]);
    });

    test('strips frontmatter and chunks remaining content', () => {
      const content = `---
title: Test Note
---

# Hello

This is the content.`;

      const result = service.chunkMarkdown(content);

      expect(result.length).toBe(1);
      expect(result[0].content).toContain('# Hello');
      expect(result[0].content).toContain('This is the content.');
    });

    test('creates single chunk for short content', () => {
      const content = '# Short Note\n\nThis is a short paragraph.';

      const result = service.chunkMarkdown(content);

      expect(result.length).toBe(1);
      expect(result[0].chunkIndex).toBe(0);
      expect(result[0].heading).toBe('Short Note');
    });

    test('extracts heading from content', () => {
      const content = `# Main Heading

Some paragraph under main heading.

## Sub Heading

More content under sub heading.`;

      const result = service.chunkMarkdown(content);

      expect(result.length).toBeGreaterThanOrEqual(1);
      // The last heading encountered should be tracked
      expect(result[0].heading).toBeDefined();
    });

    test('generates preview limited to ~200 chars', () => {
      const longParagraph = 'This is a sentence. '.repeat(50);
      const content = `# Test\n\n${longParagraph}`;

      const result = service.chunkMarkdown(content);

      expect(result[0].preview.length).toBeLessThanOrEqual(203); // 200 + "..."
      expect(result[0].preview).toMatch(/\.\.\.$/);
    });

    test('preview for short content does not have ellipsis', () => {
      const content = '# Test\n\nShort content here.';

      const result = service.chunkMarkdown(content);

      expect(result[0].preview).not.toMatch(/\.\.\.$/);
    });

    test('handles multiple heading levels', () => {
      const content = `# H1
Content 1
## H2
Content 2
### H3
Content 3`;

      const result = service.chunkMarkdown(content);

      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    test('handles code blocks', () => {
      const content = `# Code Example

\`\`\`javascript
const x = 1;
const y = 2;
\`\`\`

After code.`;

      const result = service.chunkMarkdown(content);

      expect(result.length).toBeGreaterThanOrEqual(1);
      // Code block content should be preserved
      const allContent = result.map(c => c.content).join('\n');
      expect(allContent).toContain('const x = 1');
    });

    test('handles lists', () => {
      const content = `# List Test

- Item 1
- Item 2
- Item 3

Paragraph after list.`;

      const result = service.chunkMarkdown(content);

      const allContent = result.map(c => c.content).join('\n');
      expect(allContent).toContain('Item 1');
      expect(allContent).toContain('Item 2');
      expect(allContent).toContain('Item 3');
    });

    test('handles blockquotes', () => {
      const content = `# Quote Test

> This is a quote
> that spans multiple lines

After quote.`;

      const result = service.chunkMarkdown(content);

      const allContent = result.map(c => c.content).join('\n');
      expect(allContent).toContain('This is a quote');
    });

    test('generates unique content hash for each chunk', () => {
      const content = `# Section 1

Content for section 1.

# Section 2

Different content for section 2.`;

      // Use small chunk size to force multiple chunks
      const result = service.chunkMarkdown(content, { maxTokens: 50 });

      if (result.length > 1) {
        const hashes = result.map(c => c.contentHash);
        const uniqueHashes = new Set(hashes);
        expect(uniqueHashes.size).toBe(hashes.length);
      }
    });

    test('respects custom maxTokens option', () => {
      const longContent = 'Word '.repeat(1000);
      const content = `# Test\n\n${longContent}`;

      const smallChunks = service.chunkMarkdown(content, { maxTokens: 100 });
      const largeChunks = service.chunkMarkdown(content, { maxTokens: 2000 });

      expect(smallChunks.length).toBeGreaterThan(largeChunks.length);
    });

    test('chunk indices are sequential', () => {
      const longContent = 'Sentence here. '.repeat(200);
      const content = `# Test\n\n${longContent}`;

      const result = service.chunkMarkdown(content, { maxTokens: 100 });

      for (let i = 0; i < result.length; i++) {
        expect(result[i].chunkIndex).toBe(i);
      }
    });
  });

  describe('generatePreview', () => {
    test('removes heading markers', () => {
      const preview = service.generatePreview('# Heading\n\nContent');
      expect(preview).not.toContain('# ');
      expect(preview).toContain('Heading');
    });

    test('normalizes whitespace', () => {
      const preview = service.generatePreview('Line 1\n\nLine 2\n\n\nLine 3');
      expect(preview).not.toContain('\n');
      expect(preview).toBe('Line 1 Line 2 Line 3');
    });

    test('truncates at word boundary when possible', () => {
      const longText = 'word '.repeat(100);
      const preview = service.generatePreview(longText);

      expect(preview.length).toBeLessThanOrEqual(203);
      // Should end with word + ellipsis, not mid-word
      expect(preview).toMatch(/word\.\.\.$/);
    });
  });

  describe('estimateTokens', () => {
    test('estimates roughly 4 characters per token', () => {
      const text = 'a'.repeat(100);
      const tokens = service.estimateTokens(text);
      expect(tokens).toBe(25);
    });

    test('rounds up for partial tokens', () => {
      const text = 'a'.repeat(101);
      const tokens = service.estimateTokens(text);
      expect(tokens).toBe(26);
    });
  });

  describe('edge cases', () => {
    test('handles content with only code block', () => {
      const content = `\`\`\`python
print("hello")
\`\`\``;

      const result = service.chunkMarkdown(content);
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    test('handles unclosed code block', () => {
      const content = `# Test
\`\`\`python
print("hello")`;

      const result = service.chunkMarkdown(content);
      // Should not throw, should handle gracefully
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    test('handles numbered lists', () => {
      const content = `# Numbered List

1. First item
2. Second item
3. Third item`;

      const result = service.chunkMarkdown(content);
      const allContent = result.map(c => c.content).join('\n');
      expect(allContent).toContain('First item');
    });

    test('handles nested lists', () => {
      const content = `# Nested

- Parent
  - Child 1
  - Child 2
- Another parent`;

      const result = service.chunkMarkdown(content);
      const allContent = result.map(c => c.content).join('\n');
      expect(allContent).toContain('Parent');
      expect(allContent).toContain('Child 1');
    });

    test('handles content starting with paragraph', () => {
      const content = 'Just a paragraph without any heading.';

      const result = service.chunkMarkdown(content);
      expect(result.length).toBe(1);
      expect(result[0].heading).toBeNull();
    });

    test('handles mixed content types', () => {
      const content = `# Mixed Content

A paragraph here.

- List item

> A quote

\`\`\`
code block
\`\`\`

## Another Section

More text.`;

      const result = service.chunkMarkdown(content);
      expect(result.length).toBeGreaterThanOrEqual(1);

      const allContent = result.map(c => c.content).join('\n');
      expect(allContent).toContain('A paragraph here');
      expect(allContent).toContain('List item');
      expect(allContent).toContain('A quote');
      expect(allContent).toContain('code block');
      expect(allContent).toContain('More text');
    });
  });
});
