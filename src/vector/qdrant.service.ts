import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import { PinoLogger } from 'nestjs-pino';
import type { ConversationTurnPayload } from '../memory/conversation-turn.schemas';
import type { Chunk } from './chunking.service';
import {
  type ChunkPoint,
  type ChunkSearchResult,
  type SearchResult,
  type VectorPoint,
} from './vector.schemas';

/** OpenAI text-embedding-3-small vector dimension */
const VECTOR_DIMENSION = 1536;
const CONVERSATION_COLLECTION = 'conversation-turns';

/** Default number of results for search operations */
const DEFAULT_SEARCH_LIMIT = 5;
/** Batch size for scrolling through collections */
const SCROLL_BATCH_SIZE = 100;
/** UUID segment boundaries for formatting hashes as UUIDs (8-4-4-4-12 format) */
// biome-ignore lint/style/noMagicNumbers: these define the UUID segment boundaries
const UUID_SEGMENTS = [0, 8, 12, 16, 20, 32] as const;
/** Hash padding length */
const HASH_PAD_LENGTH = 32;
/** Hash radix (hexadecimal) */
const HEX_RADIX = 16;
/** Default score for non-search results */
const DEFAULT_SCORE = 1.0;
/** Padding for hash byte conversion */
const BYTE_PAD_LENGTH = 2;

export interface ChunkUpsertData {
  chunk: Chunk;
  embedding: number[];
  path: string;
  totalChunks: number;
  documentHash: string;
  title: string;
  tags: string[];
}

export interface SummaryUpsertData {
  embedding: number[];
  path: string;
  documentHash: string;
  title: string;
  tags: string[];
  summary: string;
}

@Injectable()
export class QdrantService implements OnModuleInit {
  private readonly client: QdrantClient;
  private readonly collectionName: string;

  constructor(
    private readonly logger: PinoLogger,
    private configService: ConfigService,
  ) {
    this.logger.setContext(QdrantService.name);
    const qdrantUrl = this.configService.get<string>('vector.qdrantUrl');
    this.collectionName = this.configService.get<string>(
      'vector.collectionName',
    );
    this.client = new QdrantClient({ url: qdrantUrl });
  }

  async onModuleInit() {
    await Promise.all([
      this.initCollection(),
      this.ensureConversationCollection(),
    ]);
  }

  async initCollection(): Promise<void> {
    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(
        c => c.name === this.collectionName,
      );

      if (!exists) {
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: VECTOR_DIMENSION,
            distance: 'Cosine',
          },
        });
        this.logger.info(
          { collectionName: this.collectionName },
          'Created collection',
        );
      } else {
        this.logger.info(
          { collectionName: this.collectionName },
          'Collection exists',
        );
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Error initializing Qdrant collection');
      throw error;
    }
  }

  async upsertNote(
    path: string,
    content: string,
    embedding: number[],
    metadata: Partial<VectorPoint> = {},
  ): Promise<void> {
    try {
      const id = this.pathToId(path);
      const contentHash = await this.hashContent(content);

      await this.client.upsert(this.collectionName, {
        points: [
          {
            id,
            vector: embedding,
            payload: {
              path,
              content,
              contentHash,
              title: metadata.title || this.extractTitle(path),
              tags: metadata.tags || [],
              updatedAt: Date.now(),
              chunkIndex: metadata.chunkIndex || 0,
            },
          },
        ],
      });
    } catch (error) {
      this.logger.error({ err: error, path }, 'Error upserting note');
      throw error;
    }
  }

  async deleteNote(path: string): Promise<void> {
    try {
      await this.client.delete(this.collectionName, {
        filter: {
          must: [
            {
              key: 'path',
              match: { value: path },
            },
          ],
        },
      });
    } catch (error) {
      this.logger.error({ err: error, path }, 'Error deleting note');
      throw error;
    }
  }

  /**
   * Delete all chunks for a document
   */
  async deleteDocumentChunks(path: string): Promise<void> {
    try {
      await this.client.delete(this.collectionName, {
        filter: {
          must: [
            {
              key: 'path',
              match: { value: path },
            },
          ],
        },
      });
      this.logger.debug({ path }, 'Deleted all chunks');
    } catch (error) {
      this.logger.error({ err: error, path }, 'Error deleting chunks');
      throw error;
    }
  }

  /**
   * Batch upsert chunks for a document
   */
  async upsertChunks(chunks: ChunkUpsertData[]): Promise<void> {
    if (chunks.length === 0) return;

    try {
      const points = chunks.map(data => {
        const id = this.chunkToId(data.path, data.chunk.chunkIndex);
        return {
          id,
          vector: data.embedding,
          payload: {
            path: data.path,
            chunkIndex: data.chunk.chunkIndex,
            totalChunks: data.totalChunks,
            heading: data.chunk.heading,
            contentPreview: data.chunk.preview,
            contentHash: data.chunk.contentHash,
            documentHash: data.documentHash,
            title: data.title,
            tags: data.tags,
            updatedAt: Date.now(),
          } satisfies ChunkPoint,
        };
      });

      await this.client.upsert(this.collectionName, { points });
      this.logger.debug({ count: chunks.length }, 'Upserted chunks');
    } catch (error) {
      this.logger.error({ err: error }, 'Error upserting chunks');
      throw error;
    }
  }

  /**
   * Upsert a summary-level embedding for document-level search and dedup.
   * Uses a separate ID pattern (path:summary) to avoid collisions with chunk IDs.
   */
  async upsertSummary(data: SummaryUpsertData): Promise<void> {
    try {
      const id = this.chunkToId(data.path, -1); // Use -1 as sentinel for summary
      await this.client.upsert(this.collectionName, {
        points: [
          {
            id,
            vector: data.embedding,
            payload: {
              path: data.path,
              chunkIndex: -1,
              totalChunks: 0,
              heading: null,
              contentPreview: data.summary,
              contentHash: '',
              documentHash: data.documentHash,
              title: data.title,
              tags: data.tags,
              updatedAt: Date.now(),
              type: 'summary',
            } satisfies ChunkPoint,
          },
        ],
      });
      this.logger.debug({ path: data.path }, 'Upserted summary embedding');
    } catch (error) {
      this.logger.error({ err: error }, 'Error upserting summary');
      throw error;
    }
  }

  /**
   * Search for similar notes using summary embeddings only.
   * Used for document-level similarity (dedup, search).
   */
  async searchSummaries(
    embedding: number[],
    limit = DEFAULT_SEARCH_LIMIT,
  ): Promise<ChunkSearchResult[]> {
    try {
      const results = await this.client.search(this.collectionName, {
        vector: embedding,
        limit,
        with_payload: true,
        filter: {
          must: [{ key: 'type', match: { value: 'summary' } }],
        },
      });

      return results.map(r => ({
        path: r.payload?.path as string,
        score: r.score,
        chunkIndex: r.payload?.chunkIndex as number,
        totalChunks: r.payload?.totalChunks as number,
        heading: r.payload?.heading as string | null,
        contentPreview: r.payload?.contentPreview as string,
        title: r.payload?.title as string,
      }));
    } catch (error) {
      this.logger.error({ err: error }, 'Error searching summaries');
      throw error;
    }
  }

  /**
   * Search for similar chunks (returns chunk metadata, not full content)
   */
  async searchSimilarChunks(
    embedding: number[],
    limit = DEFAULT_SEARCH_LIMIT,
  ): Promise<ChunkSearchResult[]> {
    try {
      const results = await this.client.search(this.collectionName, {
        vector: embedding,
        limit,
        with_payload: true,
      });

      return results.map(r => ({
        path: r.payload?.path as string,
        score: r.score,
        chunkIndex: r.payload?.chunkIndex as number,
        totalChunks: r.payload?.totalChunks as number,
        heading: r.payload?.heading as string | null,
        contentPreview: r.payload?.contentPreview as string,
        title: r.payload?.title as string,
      }));
    } catch (error) {
      this.logger.error({ err: error }, 'Error searching similar chunks');
      throw error;
    }
  }

  /**
   * Get surrounding chunks for a given chunk (for context expansion)
   */
  async getSurroundingChunks(
    path: string,
    chunkIndex: number,
    range = 1,
  ): Promise<ChunkSearchResult[]> {
    try {
      const startIndex = Math.max(0, chunkIndex - range);
      const endIndex = chunkIndex + range;

      const results = await this.client.scroll(this.collectionName, {
        filter: {
          must: [
            { key: 'path', match: { value: path } },
            { key: 'chunkIndex', range: { gte: startIndex, lte: endIndex } },
          ],
        },
        limit: endIndex - startIndex + 1,
        with_payload: true,
      });

      return results.points
        .map(p => ({
          path: p.payload?.path as string,
          score: DEFAULT_SCORE,
          chunkIndex: p.payload?.chunkIndex as number,
          totalChunks: p.payload?.totalChunks as number,
          heading: p.payload?.heading as string | null,
          contentPreview: p.payload?.contentPreview as string,
          title: p.payload?.title as string,
        }))
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
    } catch (error) {
      this.logger.error({ err: error }, 'Error getting surrounding chunks');
      throw error;
    }
  }

  async searchSimilar(
    embedding: number[],
    limit = DEFAULT_SEARCH_LIMIT,
  ): Promise<SearchResult[]> {
    try {
      const results = await this.client.search(this.collectionName, {
        vector: embedding,
        limit,
        with_payload: true,
      });

      return results.map(r => ({
        path: r.payload?.path as string,
        score: r.score,
        content: r.payload?.content as string,
      }));
    } catch (error) {
      this.logger.error({ err: error }, 'Error searching similar notes');
      throw error;
    }
  }

  async getAllIndexedPaths(): Promise<
    Map<string, { contentHash: string; updatedAt: number }>
  > {
    const indexed = new Map<
      string,
      { contentHash: string; updatedAt: number }
    >();

    try {
      let offset: string | number | Record<string, unknown> | undefined;
      const batchSize = SCROLL_BATCH_SIZE;

      while (true) {
        const result = await this.client.scroll(this.collectionName, {
          limit: batchSize,
          offset,
          with_payload: true,
        });

        for (const point of result.points) {
          const path = point.payload?.path as string;
          const contentHash = point.payload?.contentHash as string;
          const updatedAt = point.payload?.updatedAt as number;
          if (path) {
            indexed.set(path, { contentHash, updatedAt });
          }
        }

        if (result.points.length < batchSize) break;
        offset = result.next_page_offset;
        if (!offset) break;
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Error getting indexed paths');
      throw error;
    }

    return indexed;
  }

  /**
   * Get all indexed documents with their document hashes (for chunk-based sync)
   */
  async getAllIndexedDocuments(): Promise<
    Map<string, { documentHash: string; chunkCount: number }>
  > {
    const indexed = new Map<
      string,
      { documentHash: string; chunkCount: number }
    >();

    try {
      let offset: string | number | Record<string, unknown> | undefined;
      const batchSize = SCROLL_BATCH_SIZE;

      while (true) {
        const result = await this.client.scroll(this.collectionName, {
          limit: batchSize,
          offset,
          with_payload: true,
        });

        for (const point of result.points) {
          const path = point.payload?.path as string;
          const documentHash = point.payload?.documentHash as string;
          const totalChunks = point.payload?.totalChunks as number;

          if (path && documentHash) {
            // Only store once per document (first chunk seen)
            if (!indexed.has(path)) {
              indexed.set(path, {
                documentHash,
                chunkCount: totalChunks || 1,
              });
            }
          }
        }

        if (result.points.length < batchSize) break;
        offset = result.next_page_offset;
        if (!offset) break;
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Error getting indexed documents');
      throw error;
    }

    return indexed;
  }

  async getContentHash(path: string): Promise<string | null> {
    try {
      const results = await this.client.scroll(this.collectionName, {
        filter: {
          must: [
            {
              key: 'path',
              match: { value: path },
            },
          ],
        },
        limit: 1,
        with_payload: true,
      });

      if (results.points.length === 0) return null;
      return results.points[0].payload?.contentHash as string;
    } catch (error) {
      this.logger.error({ err: error, path }, 'Error getting content hash');
      return null;
    }
  }

  // ============================================
  // Conversation Turn Methods
  // ============================================

  /**
   * Ensure the conversation-turns collection exists.
   * Called during module initialization.
   */
  async ensureConversationCollection(): Promise<void> {
    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(
        c => c.name === CONVERSATION_COLLECTION,
      );

      if (!exists) {
        await this.client.createCollection(CONVERSATION_COLLECTION, {
          vectors: {
            size: VECTOR_DIMENSION,
            distance: 'Cosine',
          },
        });
        this.logger.info(
          { collectionName: CONVERSATION_COLLECTION },
          'Created conversation collection',
        );
      }
    } catch (error) {
      this.logger.error(
        { err: error },
        'Error initializing conversation collection',
      );
      throw error;
    }
  }

  /**
   * Store a conversation turn with its embedding for semantic search.
   * @param id UUIDv7 for time-sortable ordering
   * @param embedding Vector embedding of the turn content
   * @param payload Turn metadata (userId, messages, timestamp, etc.)
   */
  async upsertConversationTurn(
    id: string,
    embedding: number[],
    payload: ConversationTurnPayload,
  ): Promise<void> {
    try {
      await this.client.upsert(CONVERSATION_COLLECTION, {
        points: [{ id, vector: embedding, payload }],
      });
    } catch (error) {
      this.logger.error({ err: error }, 'Error upserting conversation turn');
      throw error;
    }
  }

  /**
   * Search for semantically similar conversation turns.
   * @param embedding Query embedding
   * @param userId Filter to specific user
   * @param limit Maximum results to return
   * @returns Matching turns with scores
   */
  async searchConversationTurns(
    embedding: number[],
    userId: number,
    limit = DEFAULT_SEARCH_LIMIT,
  ): Promise<Array<ConversationTurnPayload & { score: number }>> {
    try {
      const results = await this.client.search(CONVERSATION_COLLECTION, {
        vector: embedding,
        filter: {
          must: [{ key: 'userId', match: { value: userId } }],
        },
        limit,
        with_payload: true,
      });

      return results.map(r => ({
        userId: r.payload?.userId as number,
        userMessage: r.payload?.userMessage as string,
        assistantResponse: r.payload?.assistantResponse as string,
        timestamp: r.payload?.timestamp as number,
        toolsUsed: r.payload?.toolsUsed as string[] | undefined,
        score: r.score,
      }));
    } catch (error) {
      this.logger.error({ err: error }, 'Error searching conversation turns');
      throw error;
    }
  }

  /**
   * Delete old conversation turns for a user.
   * Used for cleanup of turns older than retention period.
   * @param userId User to clean up
   * @param beforeTimestamp Delete turns older than this timestamp
   */
  async deleteOldConversationTurns(
    userId: number,
    beforeTimestamp: number,
  ): Promise<void> {
    try {
      await this.client.delete(CONVERSATION_COLLECTION, {
        filter: {
          must: [
            { key: 'userId', match: { value: userId } },
            { key: 'timestamp', range: { lt: beforeTimestamp } },
          ],
        },
      });
      this.logger.debug(
        { userId, beforeTimestamp },
        'Deleted old conversation turns',
      );
    } catch (error) {
      this.logger.error(
        { err: error },
        'Error deleting old conversation turns',
      );
      throw error;
    }
  }

  /**
   * Formats a 32-character hash string as a UUID
   */
  private formatAsUuid(hash: string): string {
    const [s0, s1, s2, s3, s4, s5] = UUID_SEGMENTS;
    return `${hash.substring(s0, s1)}-${hash.substring(s1, s2)}-${hash.substring(s2, s3)}-${hash.substring(s3, s4)}-${hash.substring(s4, s5)}`;
  }

  private pathToId(path: string): string {
    // Generate a UUID-like ID from the path using a hash
    const hash = this.simpleHash(path);
    return this.formatAsUuid(hash);
  }

  private chunkToId(path: string, chunkIndex: number): string {
    // Generate a UUID-like ID from path + chunk index
    const hash = this.simpleHash(`${path}:chunk:${chunkIndex}`);
    return this.formatAsUuid(hash);
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(HEX_RADIX).padStart(HASH_PAD_LENGTH, '0');
  }

  private async hashContent(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('MD5', data).catch(() => {
      // Fallback for environments without MD5 support
      return this.simpleHash(content);
    });

    if (typeof hashBuffer === 'string') return hashBuffer;

    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray
      .map(b => b.toString(HEX_RADIX).padStart(BYTE_PAD_LENGTH, '0'))
      .join('');
  }

  private extractTitle(path: string): string {
    const filename = path.split('/').pop() || path;
    return filename.replace(/\.md$/, '');
  }
}
