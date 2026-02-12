import {
  ElevenLabsClient,
  ElevenLabsError,
  ElevenLabsTimeoutError,
} from '@elevenlabs/elevenlabs-js';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

/** Cache TTL for transcription results (24 hours). */
const TRANSCRIPTION_CACHE_TTL = 86_400_000;

/**
 * Transcription result returned from the service.
 */
export interface TranscriptionResult {
  success: boolean;
  text?: string;
  error?: string;
}

/**
 * Audio file metadata for transcription.
 */
export interface AudioFileMetadata {
  /** Unique identifier for caching (e.g., Telegram's file_unique_id) */
  fileUniqueId: string;
  /** Original filename or generated name with extension */
  filename: string;
}

/**
 * Service for transcribing audio using ElevenLabs Scribe v2.
 *
 * Features:
 * - Transcribes audio buffers to text using Scribe v2
 * - Caches results by file_unique_id for 24 hours
 * - Returns structured results with success/error states
 */
@Injectable()
export class TranscriptionService {
  private client: ElevenLabsClient | null = null;

  constructor(
    private readonly logger: PinoLogger,
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {
    this.logger.setContext(TranscriptionService.name);
    this.initializeClient();
  }

  private initializeClient(): void {
    const apiKey = this.configService.get<string>('elevenlabs.apiKey');
    if (apiKey) {
      this.client = new ElevenLabsClient({ apiKey });
    }
  }

  /**
   * Transcribes audio to text using ElevenLabs Scribe v2.
   *
   * @param audioBuffer - The audio file as a Buffer
   * @param metadata - File metadata including unique ID for caching
   * @returns Transcription result with text or error
   */
  async transcribe(
    audioBuffer: Buffer,
    metadata: AudioFileMetadata,
  ): Promise<TranscriptionResult> {
    const cacheKey = `transcription:${metadata.fileUniqueId}`;

    const cached = await this.cache.get<string>(cacheKey);
    if (cached) {
      this.logger.debug(
        { fileUniqueId: metadata.fileUniqueId },
        'Transcription cache hit',
      );
      return { success: true, text: cached };
    }

    if (!this.client) {
      this.logger.error('ElevenLabs client not initialized - missing API key');
      return {
        success: false,
        error: 'Transcription service not configured',
      };
    }

    if (audioBuffer.length === 0) {
      return {
        success: false,
        error: 'Empty audio file',
      };
    }

    try {
      const file = new File([new Uint8Array(audioBuffer)], metadata.filename, {
        type: 'audio/ogg',
      });

      const response = await this.client.speechToText.convert({
        file,
        modelId: 'scribe_v2',
      });

      if (!('text' in response)) {
        this.logger.warn(
          { fileUniqueId: metadata.fileUniqueId },
          'Unexpected multichannel response from Scribe',
        );
        return {
          success: false,
          error: 'Unexpected transcription response format',
        };
      }

      const text = response.text.trim();

      if (!text) {
        this.logger.warn(
          { fileUniqueId: metadata.fileUniqueId },
          'Scribe returned empty transcription',
        );
        return {
          success: false,
          error: 'Could not understand audio',
        };
      }

      await this.cache.set(cacheKey, text, TRANSCRIPTION_CACHE_TTL);
      this.logger.debug(
        { fileUniqueId: metadata.fileUniqueId, textLength: text.length },
        'Transcription cached',
      );

      return { success: true, text };
    } catch (error) {
      this.logger.error({ err: error }, 'Scribe transcription failed');

      if (error instanceof ElevenLabsTimeoutError) {
        return {
          success: false,
          error: 'Transcription request timed out',
        };
      }

      if (error instanceof ElevenLabsError) {
        return {
          success: false,
          error: `Transcription API error: ${error.statusCode}`,
        };
      }

      return {
        success: false,
        error: 'Transcription failed',
      };
    }
  }
}
