import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

/** Maximum characters for content preview */
const PREVIEW_MAX_CHARS = 200;
/** Minimum position for word boundary truncation in preview */
const PREVIEW_MIN_WORD_BOUNDARY = 150;
/** Average characters per token for English text (approximation) */
const CHARS_PER_TOKEN = 4;
/** Tokens to words ratio for overlap extraction (1 token ≈ 0.75 words) */
const TOKENS_TO_WORDS_RATIO = 0.75;
/** Padding length for content hash */
const HASH_PAD_LENGTH = 8;
/** Hexadecimal radix for hash conversion */
const HEX_RADIX = 16;

export interface Chunk {
  content: string;
  preview: string;
  chunkIndex: number;
  heading: string | null;
  contentHash: string;
}

export interface ChunkingOptions {
  maxTokens: number;
  overlapTokens: number;
}

interface MarkdownBlock {
  type: 'heading' | 'paragraph' | 'list' | 'code' | 'blockquote';
  content: string;
  headingLevel?: number;
  headingText?: string;
}

@Injectable()
export class ChunkingService {
  private readonly defaultMaxTokens: number;
  private readonly defaultOverlapTokens: number;

  constructor(
    private readonly logger: PinoLogger,
    private configService: ConfigService,
  ) {
    this.logger.setContext(ChunkingService.name);
    this.defaultMaxTokens = this.configService.get<number>('vector.chunkSize');
    this.defaultOverlapTokens = this.configService.get<number>(
      'vector.chunkOverlap',
    );
  }

  /**
   * Chunk markdown content into semantically meaningful pieces
   */
  chunkMarkdown(content: string, options?: Partial<ChunkingOptions>): Chunk[] {
    const maxTokens = options?.maxTokens ?? this.defaultMaxTokens;
    const overlapTokens = options?.overlapTokens ?? this.defaultOverlapTokens;

    const strippedContent = this.stripFrontmatter(content);
    if (!strippedContent.trim()) {
      return [];
    }

    const blocks = this.parseMarkdownBlocks(strippedContent);
    const chunks = this.mergeBlocksIntoChunks(blocks, maxTokens, overlapTokens);

    return chunks;
  }

  /**
   * Strip YAML frontmatter from content
   */
  private stripFrontmatter(content: string): string {
    const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n?/);
    if (frontmatterMatch) {
      return content.slice(frontmatterMatch[0].length);
    }
    return content;
  }

  /**
   * Parse markdown into semantic blocks
   */
  private parseMarkdownBlocks(content: string): MarkdownBlock[] {
    const blocks: MarkdownBlock[] = [];
    const lines = content.split('\n');

    let currentBlock: MarkdownBlock | null = null;
    let currentHeading: string | null = null;
    let inCodeBlock = false;
    let codeBlockContent = '';

    const flushCurrentBlock = () => {
      if (currentBlock?.content.trim()) {
        blocks.push(currentBlock);
      }
      currentBlock = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Handle code blocks
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          codeBlockContent += line;
          blocks.push({
            type: 'code',
            content: codeBlockContent,
            headingText: currentHeading,
          });
          codeBlockContent = '';
          inCodeBlock = false;
        } else {
          flushCurrentBlock();
          inCodeBlock = true;
          codeBlockContent = `${line}\n`;
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent += `${line}\n`;
        continue;
      }

      // Handle headings
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flushCurrentBlock();
        currentHeading = headingMatch[2].trim();
        blocks.push({
          type: 'heading',
          content: line,
          headingLevel: headingMatch[1].length,
          headingText: currentHeading,
        });
        continue;
      }

      // Handle blockquotes
      if (line.startsWith('>')) {
        if (currentBlock?.type !== 'blockquote') {
          flushCurrentBlock();
          currentBlock = {
            type: 'blockquote',
            content: '',
            headingText: currentHeading,
          };
        }
        currentBlock.content += `${line}\n`;
        continue;
      }

      // Handle list items
      if (line.match(/^[\s]*[-*+]\s/) || line.match(/^[\s]*\d+\.\s/)) {
        if (currentBlock?.type !== 'list') {
          flushCurrentBlock();
          currentBlock = {
            type: 'list',
            content: '',
            headingText: currentHeading,
          };
        }
        currentBlock.content += `${line}\n`;
        continue;
      }

      // Handle empty lines (paragraph separator)
      if (!line.trim()) {
        flushCurrentBlock();
        continue;
      }

      // Regular paragraph content
      if (currentBlock?.type !== 'paragraph') {
        flushCurrentBlock();
        currentBlock = {
          type: 'paragraph',
          content: '',
          headingText: currentHeading,
        };
      }
      currentBlock.content += `${line}\n`;
    }

    // Flush remaining content
    flushCurrentBlock();
    if (inCodeBlock && codeBlockContent) {
      blocks.push({
        type: 'code',
        content: codeBlockContent,
        headingText: currentHeading,
      });
    }

    return blocks;
  }

  /**
   * Merge blocks into chunks respecting token limits
   */
  private mergeBlocksIntoChunks(
    blocks: MarkdownBlock[],
    maxTokens: number,
    overlapTokens: number,
  ): Chunk[] {
    if (blocks.length === 0) {
      return [];
    }

    const chunks: Chunk[] = [];
    let currentContent = '';
    let currentHeading: string | null = null;
    let currentTokens = 0;

    const createChunk = (
      content: string,
      heading: string | null,
      index: number,
    ): Chunk => {
      return {
        content: content.trim(),
        preview: this.generatePreview(content),
        chunkIndex: index,
        heading,
        contentHash: this.hashContent(content),
      };
    };

    for (const block of blocks) {
      const blockTokens = this.estimateTokens(block.content);

      // Update heading context
      if (block.type === 'heading') {
        currentHeading = block.headingText ?? null;
      }

      // If single block exceeds max, split it
      if (blockTokens > maxTokens) {
        // Flush current content first
        if (currentContent.trim()) {
          chunks.push(
            createChunk(currentContent, currentHeading, chunks.length),
          );
          currentContent = '';
          currentTokens = 0;
        }

        // Split large block
        const splitChunks = this.splitLargeBlock(
          block.content,
          block.headingText ?? null,
          maxTokens,
          overlapTokens,
          chunks.length,
        );
        chunks.push(...splitChunks);
        continue;
      }

      // If adding this block would exceed limit, flush and start new chunk
      if (currentTokens + blockTokens > maxTokens && currentContent.trim()) {
        chunks.push(createChunk(currentContent, currentHeading, chunks.length));

        // Apply overlap from previous chunk
        const overlap = this.extractOverlap(currentContent, overlapTokens);
        currentContent = overlap ? `${overlap}\n\n` : '';
        currentTokens = this.estimateTokens(currentContent);
      }

      // Add block to current chunk
      currentContent += `${block.content}\n\n`;
      currentTokens += blockTokens;
    }

    // Flush remaining content
    if (currentContent.trim()) {
      chunks.push(createChunk(currentContent, currentHeading, chunks.length));
    }

    return chunks;
  }

  /**
   * Split a large block that exceeds token limit
   */
  private splitLargeBlock(
    content: string,
    heading: string | null,
    maxTokens: number,
    overlapTokens: number,
    startIndex: number,
  ): Chunk[] {
    const chunks: Chunk[] = [];
    const sentences = this.splitIntoSentences(content);

    let currentContent = '';
    let currentTokens = 0;

    for (const sentence of sentences) {
      const sentenceTokens = this.estimateTokens(sentence);

      if (currentTokens + sentenceTokens > maxTokens && currentContent.trim()) {
        chunks.push({
          content: currentContent.trim(),
          preview: this.generatePreview(currentContent),
          chunkIndex: startIndex + chunks.length,
          heading,
          contentHash: this.hashContent(currentContent),
        });

        const overlap = this.extractOverlap(currentContent, overlapTokens);
        currentContent = overlap ? `${overlap} ` : '';
        currentTokens = this.estimateTokens(currentContent);
      }

      currentContent += sentence;
      currentTokens += sentenceTokens;
    }

    if (currentContent.trim()) {
      chunks.push({
        content: currentContent.trim(),
        preview: this.generatePreview(currentContent),
        chunkIndex: startIndex + chunks.length,
        heading,
        contentHash: this.hashContent(currentContent),
      });
    }

    return chunks;
  }

  /**
   * Split text into sentences
   */
  private splitIntoSentences(text: string): string[] {
    // Split on sentence boundaries while preserving the delimiter
    return text.split(/(?<=[.!?])\s+/).filter(s => s.trim());
  }

  /**
   * Extract overlap content from end of chunk
   */
  private extractOverlap(content: string, overlapTokens: number): string {
    if (overlapTokens <= 0) return '';

    const words = content.trim().split(/\s+/);
    const wordCount = Math.ceil(overlapTokens * TOKENS_TO_WORDS_RATIO);
    const overlapWords = words.slice(-wordCount);

    return overlapWords.join(' ');
  }

  /**
   * Generate a preview (~200 chars) from content
   */
  generatePreview(content: string): string {
    const cleaned = content
      .replace(/^#+\s+/gm, '') // Remove heading markers
      .replace(/\n+/g, ' ') // Replace newlines with spaces
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();

    if (cleaned.length <= PREVIEW_MAX_CHARS) {
      return cleaned;
    }

    // Try to break at word boundary
    const truncated = cleaned.substring(0, PREVIEW_MAX_CHARS);
    const lastSpace = truncated.lastIndexOf(' ');

    if (lastSpace > PREVIEW_MIN_WORD_BOUNDARY) {
      return `${truncated.substring(0, lastSpace)}...`;
    }

    return `${truncated}...`;
  }

  /**
   * Estimate token count (approximation: ~4 chars per token for English)
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Generate hash for content
   */
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(HEX_RADIX).padStart(HASH_PAD_LENGTH, '0');
  }
}
