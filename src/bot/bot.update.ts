import { Command, Help, On, Start, Update } from 'nestjs-telegraf';
import type { Context } from 'telegraf';
import { BOT_MESSAGES } from '../common/constants';
import { ConversationService } from './conversation.service';
import { LlmService } from './llm.service';

@Update()
export class BotUpdate {
  constructor(
    private readonly llmService: LlmService,
    private readonly conversationService: ConversationService,
  ) {}

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
        // Send typing indicator
        await ctx.sendChatAction('typing');

        // Get conversation history
        const conversationHistory = await this.conversationService.getConversation(userId);

        // Get LLM response with conversation context AND userId
        const response = await this.llmService.generateResponse(
          userMessage,
          conversationHistory,
          userId,
        );

        // Store user message in conversation history
        await this.conversationService.addMessage(userId, 'user', userMessage);

        // Store assistant response in conversation history
        await this.conversationService.addMessage(userId, 'assistant', response);

        // Send response
        await ctx.reply(response);
      } catch (error) {
        console.error('Error processing message:', error);
        await ctx.reply('Sorry, I encountered an error processing your message.');
      }
    }
  }
}
