import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';

@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  constructor(@InjectBot() private bot: Telegraf) {}

  async sendMessage(userId: number, message: string): Promise<boolean> {
    try {
      await this.bot.telegram.sendMessage(userId, message);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send message to user ${userId}:`, error);
      return false;
    }
  }

  async sendMessageWithRetry(
    userId: number,
    message: string,
    maxRetries = 3,
  ): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
      const success = await this.sendMessage(userId, message);
      if (success) return true;

      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** i));
    }
    return false;
  }

  async sendTypingIndicator(userId: number): Promise<boolean> {
    try {
      await this.bot.telegram.sendChatAction(userId, 'typing');
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send typing indicator to user ${userId}:`,
        error,
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

    // Refresh every 4 seconds (Telegram typing lasts ~5s)
    const interval = setInterval(() => {
      this.sendTypingIndicator(chatId).catch(() => {
        // Ignore errors - best effort
      });
    }, 4000);

    try {
      return await fn();
    } finally {
      clearInterval(interval);
    }
  }
}
