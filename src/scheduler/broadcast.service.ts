import { Injectable } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';

@Injectable()
export class BroadcastService {
  constructor(@InjectBot() private bot: Telegraf) {}

  async sendMessage(userId: number, message: string): Promise<boolean> {
    try {
      await this.bot.telegram.sendMessage(userId, message);
      return true;
    } catch (error) {
      console.error(`Failed to send message to user ${userId}:`, error);
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
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
    return false;
  }
}
