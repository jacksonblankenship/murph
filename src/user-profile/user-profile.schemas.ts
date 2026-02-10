import { z } from 'zod';

/**
 * Schema for user profile data stored in Redis.
 * Contains user preferences and settings.
 */
export const UserProfileSchema = z.object({
  /** IANA timezone identifier (e.g., "America/New_York") */
  timezone: z.string().optional(),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;
