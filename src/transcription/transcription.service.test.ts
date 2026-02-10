import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/pino-logger.mock';
import { TranscriptionService } from './transcription.service';

describe('TranscriptionService', () => {
  let service: TranscriptionService;
  let mockConfigService: { get: ReturnType<typeof mock> };
  let mockCache: { get: ReturnType<typeof mock>; set: ReturnType<typeof mock> };
  let mockOpenAIClient: {
    audio: {
      transcriptions: {
        create: ReturnType<typeof mock>;
      };
    };
  };

  const testAudioBuffer = Buffer.from('test audio data');
  const testMetadata = {
    fileUniqueId: 'unique-123',
    filename: 'voice.ogg',
  };

  beforeEach(() => {
    mockConfigService = {
      get: mock((key: string) => {
        if (key === 'OPENAI_API_KEY') return 'test-api-key';
        return undefined;
      }),
    };
    mockCache = {
      get: mock(() => Promise.resolve(null)),
      set: mock(() => Promise.resolve()),
    };
    mockOpenAIClient = {
      audio: {
        transcriptions: {
          create: mock(() =>
            Promise.resolve({ text: 'Hello, this is a test transcription.' }),
          ),
        },
      },
    };

    service = new TranscriptionService(
      createMockLogger(),
      mockConfigService as never,
      mockCache as never,
    );

    // Inject mock OpenAI client
    (service as unknown as { client: typeof mockOpenAIClient }).client =
      mockOpenAIClient;
  });

  describe('transcribe', () => {
    test('returns cached result on cache hit', async () => {
      const cachedText = 'Previously transcribed text';
      mockCache.get = mock(() => Promise.resolve(cachedText));

      const result = await service.transcribe(testAudioBuffer, testMetadata);

      expect(result.success).toBe(true);
      expect(result.text).toBe(cachedText);
      expect(
        mockOpenAIClient.audio.transcriptions.create,
      ).not.toHaveBeenCalled();
    });

    test('calls Whisper API with correct parameters', async () => {
      await service.transcribe(testAudioBuffer, testMetadata);

      expect(
        mockOpenAIClient.audio.transcriptions.create,
      ).toHaveBeenCalledTimes(1);
      const call = mockOpenAIClient.audio.transcriptions.create.mock.calls[0];
      expect(call[0].model).toBe('whisper-1');
      expect(call[0].file).toBeInstanceOf(File);
      expect(call[0].file.name).toBe('voice.ogg');
    });

    test('caches successful transcription results', async () => {
      await service.transcribe(testAudioBuffer, testMetadata);

      expect(mockCache.set).toHaveBeenCalledTimes(1);
      const setCall = mockCache.set.mock.calls[0];
      expect(setCall[0]).toBe('transcription:unique-123');
      expect(setCall[1]).toBe('Hello, this is a test transcription.');
      expect(setCall[2]).toBe(86400000); // 24 hour TTL
    });

    test('returns error when API key is not configured', async () => {
      mockConfigService.get = mock(() => undefined);
      // Recreate service without API key
      service = new TranscriptionService(
        createMockLogger(),
        mockConfigService as never,
        mockCache as never,
      );

      const result = await service.transcribe(testAudioBuffer, testMetadata);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Transcription service not configured');
    });

    test('returns error for empty audio buffer', async () => {
      const result = await service.transcribe(Buffer.from(''), testMetadata);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty audio file');
      expect(
        mockOpenAIClient.audio.transcriptions.create,
      ).not.toHaveBeenCalled();
    });

    test('returns error when Whisper returns empty text', async () => {
      mockOpenAIClient.audio.transcriptions.create = mock(() =>
        Promise.resolve({ text: '   ' }),
      );

      const result = await service.transcribe(testAudioBuffer, testMetadata);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Could not understand audio');
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    test('handles OpenAI API errors', async () => {
      const apiError = new Error('API Error') as Error & { status: number };
      apiError.status = 429;
      // Simulate OpenAI APIError structure
      Object.defineProperty(apiError, 'constructor', {
        value: { name: 'APIError' },
      });

      mockOpenAIClient.audio.transcriptions.create = mock(() =>
        Promise.reject(apiError),
      );

      const result = await service.transcribe(testAudioBuffer, testMetadata);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Transcription failed');
    });

    test('handles generic errors', async () => {
      mockOpenAIClient.audio.transcriptions.create = mock(() =>
        Promise.reject(new Error('Network failure')),
      );

      const result = await service.transcribe(testAudioBuffer, testMetadata);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Transcription failed');
    });

    test('trims whitespace from transcription', async () => {
      mockOpenAIClient.audio.transcriptions.create = mock(() =>
        Promise.resolve({ text: '  Hello world  \n' }),
      );

      const result = await service.transcribe(testAudioBuffer, testMetadata);

      expect(result.success).toBe(true);
      expect(result.text).toBe('Hello world');
    });
  });
});
