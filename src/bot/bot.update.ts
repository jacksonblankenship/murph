import Redis from 'ioredis';
import { Command, Help, On, Start, Update } from 'nestjs-telegraf';
import type { Context } from 'telegraf';
import { BOT_MESSAGES } from '../common/constants';
import { MessagesService } from '../messages/messages.service';
import { ConversationService } from './conversation.service';

@Update()
export class BotUpdate {
  private redis: Redis;

  constructor(
    private readonly messagesService: MessagesService,
    private readonly conversationService: ConversationService,
  ) {
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
      maxRetriesPerRequest: null,
    });
  }

  @Start()
  async start(ctx: Context) {
    await ctx.reply(BOT_MESSAGES.START);
  }

  @Command('hello')
  async hello(ctx: Context) {
    await ctx.reply(BOT_MESSAGES.HELLO);
  }

  @Help()
  async help(ctx: Context) {
    await ctx.reply(BOT_MESSAGES.HELP);
  }

  @Command('newsession')
  async newSession(ctx: Context) {
    if (!ctx.from) {
      await ctx.reply('Unable to identify user.');
      return;
    }

    const userId = ctx.from.id;
    await this.conversationService.clearConversation(userId);
    await ctx.reply(BOT_MESSAGES.NEW_SESSION);
  }

  @On('text')
  async onText(ctx: Context) {
    if ('text' in ctx.message && ctx.from) {
      const userMessage = ctx.message.text;
      const userId = ctx.from.id;

      // Skip if it's a command
      if (userMessage.startsWith('/')) {
        return;
      }

      try {
        // Send typing indicator immediately
        await ctx.sendChatAction('typing');

        // Create queued message
        const timestamp = Date.now();
        const queuedMessage = {
          userId,
          content: userMessage,
          timestamp,
          messageId: `${userId}-${ctx.message.message_id}`,
          context: {
            messageId: ctx.message.message_id,
            chatId: ctx.chat.id,
          },
        };

        // Store as pending message in Redis for batching
        const pendingKey = `pending_user_message:${userId}:${timestamp}`;
        await this.redis.set(
          pendingKey,
          JSON.stringify(queuedMessage),
          'EX',
          10, // 10 second TTL
        );

        // Queue the message with debounce delay
        await this.messagesService.queueUserMessage(queuedMessage);
      } catch (error) {
        console.error('Error queueing message:', error);
        await ctx.reply('Sorry, I encountered an error processing your message.');
      }
    }
  }
}
