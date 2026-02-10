import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { StatusCodes } from 'http-status-codes';
import { MurLock } from 'murlock';
import { PinoLogger } from 'nestjs-pino';
import { firstValueFrom } from 'rxjs';

/** Lock timeout in milliseconds for file operations */
const LOCK_TIMEOUT_MS = 30_000;

import {
  ObsidianNote,
  ObsidianNoteJsonSchema,
  ObsidianNoteListSchema,
  ObsidianSearchResponseSchema,
  ObsidianSearchResult,
} from './obsidian.schemas';

@Injectable()
export class ObsidianService {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly excludePatterns: string[];

  constructor(
    private readonly logger: PinoLogger,
    private configService: ConfigService,
    private httpService: HttpService,
  ) {
    this.logger.setContext(ObsidianService.name);
    this.apiUrl = this.configService.get<string>('obsidian.apiUrl');
    this.apiKey = this.configService.get<string>('obsidian.apiKey');
    this.excludePatterns = this.configService.get<string[]>(
      'obsidian.excludePatterns',
    );
  }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'text/markdown',
    };
  }

  private shouldExclude(path: string): boolean {
    return this.excludePatterns.some(pattern => {
      if (pattern.includes('*')) {
        const regex = new RegExp(
          `^${pattern.replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
        );
        return regex.test(path);
      }
      return path.startsWith(pattern) || path.includes(`/${pattern}`);
    });
  }

  async readNote(path: string): Promise<ObsidianNote | null> {
    try {
      const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;
      const url = `${this.apiUrl}/vault/${encodeURIComponent(normalizedPath)}`;

      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: this.getHeaders(),
        }),
      );

      return {
        path: normalizedPath,
        content: response.data,
      };
    } catch (error) {
      if (
        error instanceof AxiosError &&
        error.response?.status === StatusCodes.NOT_FOUND
      ) {
        return null;
      }
      this.logger.error({ err: error, path }, 'Error reading note');
      throw error;
    }
  }

  /**
   * Gets the last modification date of a note from Obsidian's file metadata.
   * Uses the JSON response format from the Local REST API to get stat info.
   */
  async getModifiedDate(path: string): Promise<Date | null> {
    try {
      const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;
      const url = `${this.apiUrl}/vault/${encodeURIComponent(normalizedPath)}`;

      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/vnd.olrapi.note+json',
          },
        }),
      );

      const result = ObsidianNoteJsonSchema.safeParse(response.data);
      if (!result.success) {
        this.logger.error(
          { path, error: result.error.message },
          'Invalid note JSON response',
        );
        return null;
      }

      return new Date(result.data.stat.mtime);
    } catch (error) {
      if (
        error instanceof AxiosError &&
        error.response?.status === StatusCodes.NOT_FOUND
      ) {
        return null;
      }
      this.logger.error({ err: error, path }, 'Error getting modified date');
      throw error;
    }
  }

  /**
   * Gets the creation date of a note from Obsidian's file metadata.
   * Uses the JSON response format from the Local REST API to get stat info.
   *
   * Replaces the deprecated `planted` frontmatter field for determining
   * when a note was first created (e.g., orphan age detection).
   */
  async getCreatedDate(path: string): Promise<Date | null> {
    try {
      const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;
      const url = `${this.apiUrl}/vault/${encodeURIComponent(normalizedPath)}`;

      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/vnd.olrapi.note+json',
          },
        }),
      );

      const result = ObsidianNoteJsonSchema.safeParse(response.data);
      if (!result.success) {
        this.logger.error(
          { path, error: result.error.message },
          'Invalid note JSON response',
        );
        return null;
      }

      return new Date(result.data.stat.ctime);
    } catch (error) {
      if (
        error instanceof AxiosError &&
        error.response?.status === StatusCodes.NOT_FOUND
      ) {
        return null;
      }
      this.logger.error({ err: error, path }, 'Error getting created date');
      throw error;
    }
  }

  @MurLock(LOCK_TIMEOUT_MS, 'path')
  async writeNote(path: string, content: string): Promise<void> {
    try {
      const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;
      const url = `${this.apiUrl}/vault/${encodeURIComponent(normalizedPath)}`;

      await firstValueFrom(
        this.httpService.put(url, content, {
          headers: this.getHeaders(),
        }),
      );
    } catch (error) {
      this.logger.error({ err: error, path }, 'Error writing note');
      throw error;
    }
  }

  @MurLock(LOCK_TIMEOUT_MS, 'path')
  async appendToNote(path: string, content: string): Promise<void> {
    try {
      const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;
      const url = `${this.apiUrl}/vault/${encodeURIComponent(normalizedPath)}`;

      await firstValueFrom(
        this.httpService.post(url, content, {
          headers: {
            ...this.getHeaders(),
            'Content-Insertion-Position': 'end',
          },
        }),
      );
    } catch (error) {
      this.logger.error({ err: error, path }, 'Error appending to note');
      throw error;
    }
  }

  @MurLock(LOCK_TIMEOUT_MS, 'path')
  async deleteNote(path: string): Promise<void> {
    try {
      const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;
      const url = `${this.apiUrl}/vault/${encodeURIComponent(normalizedPath)}`;

      await firstValueFrom(
        this.httpService.delete(url, {
          headers: this.getHeaders(),
        }),
      );
    } catch (error) {
      if (
        error instanceof AxiosError &&
        error.response?.status === StatusCodes.NOT_FOUND
      ) {
        return; // Already deleted
      }
      this.logger.error({ err: error, path }, 'Error deleting note');
      throw error;
    }
  }

  async listNotes(folder?: string): Promise<string[]> {
    try {
      const url = folder
        ? `${this.apiUrl}/vault/${encodeURIComponent(folder)}/`
        : `${this.apiUrl}/vault/`;

      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
        }),
      );

      const result = ObsidianNoteListSchema.safeParse(response.data);

      if (!result.success) {
        this.logger.error(
          { error: result.error.message },
          'Invalid list response',
        );
        return [];
      }

      const notes: string[] = [];

      for (const file of result.data.files) {
        const fullPath = folder ? `${folder}/${file}` : file;

        if (this.shouldExclude(fullPath)) {
          continue;
        }

        if (file.endsWith('/')) {
          // Recursively list subdirectory
          const subfolderPath = fullPath.slice(0, -1); // Remove trailing slash
          const subNotes = await this.listNotes(subfolderPath);
          notes.push(...subNotes);
        } else if (file.endsWith('.md')) {
          notes.push(fullPath);
        }
      }

      return notes;
    } catch (error) {
      if (error instanceof AxiosError) {
        // 404 means the directory doesn't exist - treat as empty vault
        if (error.response?.status === StatusCodes.NOT_FOUND) {
          this.logger.warn({}, 'Vault directory not found, treating as empty');
          return [];
        }

        // 401/403 means the API key is wrong or missing
        if (
          error.response?.status === StatusCodes.UNAUTHORIZED ||
          error.response?.status === StatusCodes.FORBIDDEN
        ) {
          this.logger.error(
            {},
            'Obsidian Local REST API authentication failed. Ensure OBSIDIAN_API_KEY is set correctly in your environment.',
          );

          throw error;
        }

        // Connection failed - Obsidian not running or plugin misconfigured
        if (error.code === 'ECONNREFUSED') {
          this.logger.error(
            {},
            'Cannot connect to Obsidian Local REST API. Ensure Obsidian is running with the Local REST API plugin installed and enabled. The non-encrypted (HTTP) server must be enabled with binding host set to 0.0.0.0.',
          );

          throw error;
        }
      }

      this.logger.error({ err: error }, 'Error listing notes');
      throw error;
    }
  }

  async searchText(query: string): Promise<ObsidianSearchResult[]> {
    try {
      const url = `${this.apiUrl}/search/simple/`;

      const response = await firstValueFrom(
        this.httpService.post(
          url,
          { query },
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
          },
        ),
      );

      const result = ObsidianSearchResponseSchema.safeParse(response.data);

      if (!result.success) {
        this.logger.error(
          { error: result.error.message },
          'Invalid search response',
        );
        return [];
      }

      return result.data.filter(r => !this.shouldExclude(r.filename));
    } catch (error) {
      this.logger.error({ err: error }, 'Error searching notes');
      throw error;
    }
  }

  async getAllNotesWithContent(): Promise<ObsidianNote[]> {
    const paths = await this.listNotes();
    const notes: ObsidianNote[] = [];

    for (const path of paths) {
      const note = await this.readNote(path);
      if (note?.content.trim()) {
        notes.push(note);
      }
    }

    return notes;
  }
}
