import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { MurLock } from 'murlock';
import { firstValueFrom } from 'rxjs';
import {
  ObsidianNote,
  ObsidianNoteJsonSchema,
  ObsidianNoteListSchema,
  ObsidianSearchResponseSchema,
  ObsidianSearchResult,
} from './obsidian.schemas';

@Injectable()
export class ObsidianService {
  private readonly logger = new Logger(ObsidianService.name);
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly excludePatterns: string[];

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
  ) {
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
      if (error instanceof AxiosError && error.response?.status === 404) {
        return null;
      }
      this.logger.error(`Error reading note ${path}:`, error.message);
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
          `Invalid note JSON response for ${path}:`,
          result.error.message,
        );
        return null;
      }

      return new Date(result.data.stat.mtime);
    } catch (error) {
      if (error instanceof AxiosError && error.response?.status === 404) {
        return null;
      }
      this.logger.error(
        `Error getting modified date for ${path}:`,
        error.message,
      );
      throw error;
    }
  }

  @MurLock(30000, 'path')
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
      this.logger.error(`Error writing note ${path}:`, error.message);
      throw error;
    }
  }

  @MurLock(30000, 'path')
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
      this.logger.error(`Error appending to note ${path}:`, error.message);
      throw error;
    }
  }

  @MurLock(30000, 'path')
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
      if (error instanceof AxiosError && error.response?.status === 404) {
        return; // Already deleted
      }
      this.logger.error(`Error deleting note ${path}:`, error.message);
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
        this.logger.error('Invalid list response:', result.error.message);
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
      this.logger.error('Error listing notes:', error.message);
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
        this.logger.error('Invalid search response:', result.error.message);
        return [];
      }

      return result.data.filter(r => !this.shouldExclude(r.filename));
    } catch (error) {
      this.logger.error('Error searching notes:', error.message);
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
