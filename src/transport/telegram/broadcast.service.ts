import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';

/** Default number of retry attempts for message delivery */
const DEFAULT_MAX_RETRIES = 3;
/** Base delay in milliseconds for exponential backoff */
const RETRY_BASE_DELAY_MS = 1000;
/** Interval in milliseconds to refresh typing indicator (Telegram typing lasts ~5s) */
const TYPING_REFRESH_INTERVAL_MS = 4000;

@Injectable()
export class BroadcastService {
  constructor(
    private readonly logger: PinoLogger,
    @InjectBot() private bot: Telegraf,
  ) {
    this.logger.setContext(BroadcastService.name);
  }

  async sendMessage(userId: number, message: string): Promise<boolean> {
    try {
      await this.bot.telegram.sendMessage(userId, message);
      return true;
    } catch (error) {
      this.logger.error({ err: error, userId }, 'Failed to send message');
      return false;
    }
  }

  async sendMessageWithRetry(
    userId: number,
    message: string,
    maxRetries = DEFAULT_MAX_RETRIES,
  ): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
      const success = await this.sendMessage(userId, message);
      if (success) return true;

      // Wait before retry (exponential backoff)
      const backoffMultiplier = 2 ** i;
      await new Promise(resolve =>
        setTimeout(resolve, RETRY_BASE_DELAY_MS * backoffMultiplier),
      );
    }
    return false;
  }

  async sendTypingIndicator(userId: number): Promise<boolean> {
    try {
      await this.bot.telegram.sendChatAction(userId, 'typing');
      return true;
    } catch (error) {
      this.logger.error(
        { err: error, userId },
        'Failed to send typing indicator',
      );
      return false;
    }
  }

  /**
   * Notify user when a scheduled task fails to execute
   */
  async notifyTaskFailure(
    userId: number,
    taskId: string,
    errorMsg: string,
  ): Promise<boolean> {
    const message = `⚠️ Scheduled Task Failed\n\nTask ID: ${taskId}\nError: ${errorMsg}\n\nPlease try rescheduling or contact support if this persists.`;

    return await this.sendMessageWithRetry(userId, message);
  }

  /**
   * Execute an async function while keeping the typing indicator active.
   * Refreshes the typing indicator every 4 seconds until the function completes.
   *
   * Telegram's typing indicator only lasts ~5 seconds, so this ensures users
   * see continuous activity during long-running LLM operations.
   *
   * @param chatId - The chat ID to send typing indicators to
   * @param fn - The async function to execute
   * @returns The result of the async function
   */
  async withTypingIndicator<T>(
    chatId: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    // Send initial typing indicator
    await this.sendTypingIndicator(chatId);

    // Refresh periodically (Telegram typing lasts ~5s)
    const interval = setInterval(() => {
      this.sendTypingIndicator(chatId).catch(() => {
        // Ignore errors - best effort
      });
    }, TYPING_REFRESH_INTERVAL_MS);

    try {
      return await fn();
    } finally {
      clearInterval(interval);
    }
  }
}
