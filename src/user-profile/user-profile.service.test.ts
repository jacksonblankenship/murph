import { beforeEach, describe, expect, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/pino-logger.mock';
import { createMockRedis } from '../test/mocks/redis.mock';
import { UserProfileService } from './user-profile.service';

describe('UserProfileService', () => {
  let service: UserProfileService;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    const mockRedisService = {
      getClient: () => mockRedis,
    };
    service = new UserProfileService(
      createMockLogger(),
      mockRedisService as never,
    );
  });

  describe('getKey', () => {
    test('stores profile with correct key format', async () => {
      const userId = 12345;

      await service.setTimezone(userId, 'America/New_York');

      const storedKey = `user:profile:${userId}`;
      expect(mockRedis.store.has(storedKey)).toBe(true);
    });
  });

  describe('getTimezone', () => {
    test('returns undefined for user without profile', async () => {
      const timezone = await service.getTimezone(999);
      expect(timezone).toBeUndefined();
    });

    test('returns undefined for user without timezone set', async () => {
      const userId = 1;
      const key = `user:profile:${userId}`;
      mockRedis.store.set(key, JSON.stringify({}));

      const timezone = await service.getTimezone(userId);
      expect(timezone).toBeUndefined();
    });

    test('returns timezone when set', async () => {
      const userId = 1;
      const key = `user:profile:${userId}`;
      mockRedis.store.set(key, JSON.stringify({ timezone: 'Europe/London' }));

      const timezone = await service.getTimezone(userId);
      expect(timezone).toBe('Europe/London');
    });
  });

  describe('setTimezone', () => {
    test('stores timezone for new user', async () => {
      const userId = 1;

      await service.setTimezone(userId, 'America/New_York');

      const profile = await service.getProfile(userId);
      expect(profile?.timezone).toBe('America/New_York');
    });

    test('updates timezone for existing user', async () => {
      const userId = 1;
      await service.setTimezone(userId, 'America/New_York');

      await service.setTimezone(userId, 'Europe/Paris');

      const profile = await service.getProfile(userId);
      expect(profile?.timezone).toBe('Europe/Paris');
    });

    test('applies 30-day TTL', async () => {
      const userId = 1;

      await service.setTimezone(userId, 'America/New_York');

      const key = `user:profile:${userId}`;
      const ttl = mockRedis.ttls.get(key);
      expect(ttl).toBe(30 * 24 * 60 * 60);
    });
  });

  describe('getProfile', () => {
    test('returns null for missing profile', async () => {
      const profile = await service.getProfile(999);
      expect(profile).toBeNull();
    });

    test('returns null for invalid JSON data', async () => {
      const userId = 1;
      const key = `user:profile:${userId}`;
      mockRedis.store.set(key, 'invalid json{{{');

      await expect(service.getProfile(userId)).rejects.toThrow();
    });

    test('returns null for data failing Zod validation', async () => {
      const userId = 1;
      const key = `user:profile:${userId}`;
      // Invalid type for timezone field
      mockRedis.store.set(key, JSON.stringify({ timezone: 123 }));

      const profile = await service.getProfile(userId);
      expect(profile).toBeNull();
    });

    test('returns valid profile when data is correct', async () => {
      const userId = 1;
      const key = `user:profile:${userId}`;
      mockRedis.store.set(key, JSON.stringify({ timezone: 'Asia/Tokyo' }));

      const profile = await service.getProfile(userId);
      expect(profile).toEqual({ timezone: 'Asia/Tokyo' });
    });
  });
});
