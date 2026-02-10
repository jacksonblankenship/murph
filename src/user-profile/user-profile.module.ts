import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { UserProfileService } from './user-profile.service';

/**
 * Module for managing user profile data.
 * Provides timezone and preference storage.
 */
@Module({
  imports: [RedisModule],
  providers: [UserProfileService],
  exports: [UserProfileService],
})
export class UserProfileModule {}
