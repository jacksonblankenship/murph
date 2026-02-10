import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { RedisService } from '../redis/redis.service';
import { type UserProfile, UserProfileSchema } from './user-profile.schemas';

/** 30 days in seconds */
// biome-ignore lint/style/noMagicNumbers: time unit calculation is self-documenting
const PROFILE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Manages user profile data in Redis.
 * Stores user preferences like timezone settings.
 */
@Injectable()
export class UserProfileService {
  /** Profile data TTL - rarely changes so long cache is fine */
  private readonly TTL_SECONDS = PROFILE_TTL_SECONDS;

  constructor(
    private readonly logger: PinoLogger,
    private readonly redisService: RedisService,
  ) {
    this.logger.setContext(UserProfileService.name);
  }

  private getKey(userId: number): string {
    return `user:profile:${userId}`;
  }

  /**
   * Retrieves the user's timezone setting.
   * @param userId The user's ID
   * @returns The IANA timezone string, or undefined if not set
   */
  async getTimezone(userId: number): Promise<string | undefined> {
    const profile = await this.getProfile(userId);
    return profile?.timezone;
  }

  /**
   * Sets the user's timezone preference.
   * @param userId The user's ID
   * @param timezone IANA timezone identifier (e.g., "America/New_York")
   */
  async setTimezone(userId: number, timezone: string): Promise<void> {
    const profile = (await this.getProfile(userId)) ?? {};
    profile.timezone = timezone;
    await this.saveProfile(userId, profile);
    this.logger.info({ userId, timezone }, 'User timezone updated');
  }

  /**
   * Retrieves the full user profile.
   * @param userId The user's ID
   * @returns The user profile, or null if not found
   */
  async getProfile(userId: number): Promise<UserProfile | null> {
    const key = this.getKey(userId);
    const redis = this.redisService.getClient();

    const data = await redis.get(key);
    if (!data) {
      return null;
    }

    const result = UserProfileSchema.safeParse(JSON.parse(data));
    if (!result.success) {
      this.logger.warn(
        { userId, error: result.error.message },
        'Invalid user profile data, returning null',
      );
      return null;
    }

    return result.data;
  }

  /**
   * Saves the user profile to Redis.
   */
  private async saveProfile(
    userId: number,
    profile: UserProfile,
  ): Promise<void> {
    const key = this.getKey(userId);
    const redis = this.redisService.getClient();
    await redis.setex(key, this.TTL_SECONDS, JSON.stringify(profile));
  }
}
