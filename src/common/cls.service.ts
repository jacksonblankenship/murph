import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

/**
 * Keys for values stored in continuation-local storage.
 */
export const CLS_KEYS = {
  USER_ID: 'userId',
  CHAT_ID: 'chatId',
} as const;

/**
 * Typed wrapper around ClsService for accessing request context.
 *
 * Provides type-safe access to userId and other context values
 * without needing to pass them through function parameters.
 */
@Injectable()
export class AppClsService {
  constructor(private readonly cls: ClsService) {}

  /**
   * Set the user ID in the current context.
   */
  setUserId(userId: number): void {
    this.cls.set(CLS_KEYS.USER_ID, userId);
  }

  /**
   * Get the user ID from the current context.
   * Returns undefined if not in an active context or if userId wasn't set.
   */
  getUserId(): number | undefined {
    return this.cls.get<number>(CLS_KEYS.USER_ID);
  }

  /**
   * Get the user ID, throwing if not available.
   * Use this when userId is required for the operation.
   */
  requireUserId(): number {
    const userId = this.getUserId();
    if (userId === undefined) {
      throw new Error('userId not available in CLS context');
    }
    return userId;
  }

  /**
   * Set the chat ID in the current context.
   */
  setChatId(chatId: number): void {
    this.cls.set(CLS_KEYS.CHAT_ID, chatId);
  }

  /**
   * Get the chat ID from the current context.
   */
  getChatId(): number | undefined {
    return this.cls.get<number>(CLS_KEYS.CHAT_ID);
  }

  /**
   * Run a callback with the specified context values.
   * Useful for jobs or event handlers that need to establish context.
   */
  async runWithContext<T>(
    context: { userId: number; chatId?: number },
    callback: () => Promise<T>,
  ): Promise<T> {
    return this.cls.run(async () => {
      this.setUserId(context.userId);
      if (context.chatId !== undefined) {
        this.setChatId(context.chatId);
      }
      return callback();
    });
  }
}
