import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { Chunk } from './chunking.service';
import {
  type ChunkPoint,
  type ChunkSearchResult,
  type SearchResult,
  type VectorPoint,
} from './vector.schemas';

const VECTOR_DIMENSION = 1536; // OpenAI text-embedding-3-small

export interface ChunkUpsertData {
  chunk: Chunk;
  embedding: number[];
  path: string;
  totalChunks: number;
  documentHash: string;
  title: string;
  tags: string[];
}

@Injectable()
export class QdrantService implements OnModuleInit {
  private readonly logger = new Logger(QdrantService.name);
  private readonly client: QdrantClient;
  private readonly collectionName: string;

  constructor(private configService: ConfigService) {
    const qdrantUrl = this.configService.get<string>('vector.qdrantUrl');
    this.collectionName = this.configService.get<string>(
      'vector.collectionName',
    );
    this.client = new QdrantClient({ url: qdrantUrl });
  }

  async onModuleInit() {
    await this.initCollection();
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
        this.logger.log(`Created collection: ${this.collectionName}`);
      } else {
        this.logger.log(`Collection exists: ${this.collectionName}`);
      }
    } catch (error) {
      this.logger.error('Error initializing Qdrant collection:', error.message);
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
      this.logger.error(`Error upserting note ${path}:`, error.message);
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
      this.logger.error(`Error deleting note ${path}:`, error.message);
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
      this.logger.debug(`Deleted all chunks for: ${path}`);
    } catch (error) {
      this.logger.error(`Error deleting chunks for ${path}:`, error.message);
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
      this.logger.debug(`Upserted ${chunks.length} chunks`);
    } catch (error) {
      this.logger.error('Error upserting chunks:', error.message);
      throw error;
    }
  }

  /**
   * Search for similar chunks (returns chunk metadata, not full content)
   */
  async searchSimilarChunks(
    embedding: number[],
    limit = 5,
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
      this.logger.error('Error searching similar chunks:', error.message);
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
          score: 1.0,
          chunkIndex: p.payload?.chunkIndex as number,
          totalChunks: p.payload?.totalChunks as number,
          heading: p.payload?.heading as string | null,
          contentPreview: p.payload?.contentPreview as string,
          title: p.payload?.title as string,
        }))
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
    } catch (error) {
      this.logger.error('Error getting surrounding chunks:', error.message);
      throw error;
    }
  }

  async searchSimilar(embedding: number[], limit = 5): Promise<SearchResult[]> {
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
      this.logger.error('Error searching similar notes:', error.message);
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
      const batchSize = 100;

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
      this.logger.error('Error getting indexed paths:', error.message);
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
      const batchSize = 100;

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
      this.logger.error('Error getting indexed documents:', error.message);
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
      this.logger.error(
        `Error getting content hash for ${path}:`,
        error.message,
      );
      return null;
    }
  }

  private pathToId(path: string): string {
    // Generate a UUID-like ID from the path using a hash
    const hash = this.simpleHash(path);
    return `${hash.substring(0, 8)}-${hash.substring(8, 12)}-${hash.substring(12, 16)}-${hash.substring(16, 20)}-${hash.substring(20, 32)}`;
  }

  private chunkToId(path: string, chunkIndex: number): string {
    // Generate a UUID-like ID from path + chunk index
    const hash = this.simpleHash(`${path}:chunk:${chunkIndex}`);
    return `${hash.substring(0, 8)}-${hash.substring(8, 12)}-${hash.substring(12, 16)}-${hash.substring(16, 20)}-${hash.substring(20, 32)}`;
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(32, '0');
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
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private extractTitle(path: string): string {
    const filename = path.split('/').pop() || path;
    return filename.replace(/\.md$/, '');
  }
}
