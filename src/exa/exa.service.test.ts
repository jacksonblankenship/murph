import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { AxiosError, type AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { ExaService } from './exa.service';

describe('ExaService', () => {
  let service: ExaService;
  let mockConfigService: { get: ReturnType<typeof mock> };
  let mockHttpService: { post: ReturnType<typeof mock> };
  let mockCache: { get: ReturnType<typeof mock>; set: ReturnType<typeof mock> };

  beforeEach(() => {
    mockConfigService = {
      get: mock((key: string) => {
        if (key === 'exa.apiKey') return 'test-api-key';
        return undefined;
      }),
    };
    mockHttpService = {
      post: mock(() =>
        of({
          data: {
            results: [],
          },
        }),
      ),
    };
    mockCache = {
      get: mock(() => Promise.resolve(null)),
      set: mock(() => Promise.resolve()),
    };

    service = new ExaService(
      mockConfigService as never,
      mockHttpService as never,
      mockCache as never,
    );
  });

  describe('search', () => {
    test('returns error message when API key is not configured', async () => {
      mockConfigService.get = mock(() => undefined);

      const result = await service.search('test query');

      expect(result).toBe(
        'Error: EXA_API_KEY not configured. Please add it to .env file.',
      );
    });

    test('makes POST request with correct parameters', async () => {
      await service.search('test query', 3);

      expect(mockHttpService.post).toHaveBeenCalledTimes(1);
      const call = mockHttpService.post.mock.calls[0];
      expect(call[0]).toBe('https://api.exa.ai/search');
      expect(call[1]).toEqual({
        query: 'test query',
        num_results: 3,
        use_autoprompt: true,
      });
      expect(call[2].headers['x-api-key']).toBe('test-api-key');
      expect(call[2].headers['Content-Type']).toBe('application/json');
    });

    test('uses default numResults of 5', async () => {
      await service.search('test query');

      const call = mockHttpService.post.mock.calls[0];
      expect(call[1].num_results).toBe(5);
    });

    test('returns "No results found" for empty results', async () => {
      mockHttpService.post = mock(() =>
        of({
          data: {
            results: [],
          },
        }),
      );

      const result = await service.search('obscure query');

      expect(result).toBe('No results found for: obscure query');
    });

    test('formats results correctly', async () => {
      mockHttpService.post = mock(() =>
        of({
          data: {
            results: [
              {
                title: 'First Result',
                url: 'https://example.com/1',
                snippet: 'This is the first result.',
              },
              {
                title: 'Second Result',
                url: 'https://example.com/2',
              },
            ],
          },
        }),
      );

      const result = await service.search('test query');

      expect(result).toContain('Search results for "test query"');
      expect(result).toContain('1. First Result');
      expect(result).toContain('https://example.com/1');
      expect(result).toContain('This is the first result.');
      expect(result).toContain('2. Second Result');
      expect(result).toContain('https://example.com/2');
    });

    test('handles results without snippet', async () => {
      mockHttpService.post = mock(() =>
        of({
          data: {
            results: [
              {
                title: 'Result Without Snippet',
                url: 'https://example.com/no-snippet',
              },
            ],
          },
        }),
      );

      const result = await service.search('test query');

      expect(result).toContain('Result Without Snippet');
      expect(result).toContain('https://example.com/no-snippet');
    });

    test('handles AxiosError with response status', async () => {
      const axiosError = new AxiosError('Request failed');
      axiosError.response = {
        status: 429,
        statusText: 'Too Many Requests',
      } as AxiosResponse;

      mockHttpService.post = mock(() => throwError(() => axiosError));

      const result = await service.search('test query');

      expect(result).toBe(
        'Error performing web search: Exa API error: 429 Too Many Requests',
      );
    });

    test('handles AxiosError without response', async () => {
      const axiosError = new AxiosError('Network error');

      mockHttpService.post = mock(() => throwError(() => axiosError));

      const result = await service.search('test query');

      expect(result).toBe(
        'Error performing web search: Exa API error: unknown Network error',
      );
    });

    test('handles generic errors', async () => {
      mockHttpService.post = mock(() =>
        throwError(() => new Error('Something broke')),
      );

      const result = await service.search('test query');

      expect(result).toBe('Error performing web search: Something broke');
    });

    test('handles invalid API response format', async () => {
      mockHttpService.post = mock(() =>
        of({
          data: {
            invalid: 'format',
          },
        }),
      );

      const result = await service.search('test query');

      // Should handle gracefully with empty results
      expect(result).toBe('No results found for: test query');
    });

    test('returns cached result on cache hit', async () => {
      const cachedResult = 'cached search result';
      mockCache.get = mock(() => Promise.resolve(cachedResult));

      const result = await service.search('test query');

      expect(result).toBe(cachedResult);
      expect(mockHttpService.post).not.toHaveBeenCalled();
    });

    test('caches successful search results', async () => {
      mockHttpService.post = mock(() =>
        of({
          data: {
            results: [
              {
                title: 'Test Result',
                url: 'https://example.com/test',
              },
            ],
          },
        }),
      );

      await service.search('test query');

      expect(mockCache.set).toHaveBeenCalledTimes(1);
      const setCall = mockCache.set.mock.calls[0];
      expect(setCall[0]).toContain('exa:search:test query');
      expect(setCall[2]).toBe(3600000); // 1 hour TTL
    });
  });
});
