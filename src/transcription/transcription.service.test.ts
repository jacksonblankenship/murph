import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/pino-logger.mock';
import { TranscriptionService } from './transcription.service';

describe('TranscriptionService', () => {
  let service: TranscriptionService;
  let mockConfigService: { get: ReturnType<typeof mock> };
  let mockCache: { get: ReturnType<typeof mock>; set: ReturnType<typeof mock> };
  let mockElevenLabsClient: {
    speechToText: {
      convert: ReturnType<typeof mock>;
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
        if (key === 'elevenlabs.apiKey') return 'test-api-key';
        return undefined;
      }),
    };
    mockCache = {
      get: mock(() => Promise.resolve(null)),
      set: mock(() => Promise.resolve()),
    };
    mockElevenLabsClient = {
      speechToText: {
        convert: mock(() =>
          Promise.resolve({ text: 'Hello, this is a test transcription.' }),
        ),
      },
    };

    service = new TranscriptionService(
      createMockLogger(),
      mockConfigService as never,
      mockCache as never,
    );

    // Inject mock ElevenLabs client
    (service as unknown as { client: typeof mockElevenLabsClient }).client =
      mockElevenLabsClient;
  });

  describe('transcribe', () => {
    test('returns cached result on cache hit', async () => {
      const cachedText = 'Previously transcribed text';
      mockCache.get = mock(() => Promise.resolve(cachedText));

      const result = await service.transcribe(testAudioBuffer, testMetadata);

      expect(result.success).toBe(true);
      expect(result.text).toBe(cachedText);
      expect(mockElevenLabsClient.speechToText.convert).not.toHaveBeenCalled();
    });

    test('calls Scribe v2 API with correct parameters', async () => {
      await service.transcribe(testAudioBuffer, testMetadata);

      expect(mockElevenLabsClient.speechToText.convert).toHaveBeenCalledTimes(
        1,
      );
      const call = mockElevenLabsClient.speechToText.convert.mock.calls[0];
      expect(call[0].modelId).toBe('scribe_v2');
      expect(call[0].file).toBeInstanceOf(File);
      expect(call[0].file.name).toBe('voice.ogg');
    });

    test('caches successful transcription results', async () => {
      await service.transcribe(testAudioBuffer, testMetadata);

      expect(mockCache.set).toHaveBeenCalledTimes(1);
      const setCall = mockCache.set.mock.calls[0];
      expect(setCall[0]).toBe('transcription:unique-123');
      expect(setCall[1]).toBe('Hello, this is a test transcription.');
      expect(setCall[2]).toBe(86_400_000); // 24 hour TTL
    });

    test('returns error when API key is not configured', async () => {
      mockConfigService.get = mock(() => undefined);
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
      expect(mockElevenLabsClient.speechToText.convert).not.toHaveBeenCalled();
    });

    test('returns error when Scribe returns empty text', async () => {
      mockElevenLabsClient.speechToText.convert = mock(() =>
        Promise.resolve({ text: '   ' }),
      );

      const result = await service.transcribe(testAudioBuffer, testMetadata);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Could not understand audio');
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    test('handles generic errors', async () => {
      mockElevenLabsClient.speechToText.convert = mock(() =>
        Promise.reject(new Error('Network failure')),
      );

      const result = await service.transcribe(testAudioBuffer, testMetadata);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Transcription failed');
    });

    test('trims whitespace from transcription', async () => {
      mockElevenLabsClient.speechToText.convert = mock(() =>
        Promise.resolve({ text: '  Hello world  \n' }),
      );

      const result = await service.transcribe(testAudioBuffer, testMetadata);

      expect(result.success).toBe(true);
      expect(result.text).toBe('Hello world');
    });
  });
});
