import { Command, Help, On, Start, Update } from 'nestjs-telegraf';
import type { Context } from 'telegraf';
import { BOT_MESSAGES } from '../common/constants';
import { LlmService } from './llm.service';

@Update()
export class BotUpdate {
  constructor(private readonly llmService: LlmService) {}

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

  @On('text')
  async onText(ctx: Context) {
    if ('text' in ctx.message) {
      const userMessage = ctx.message.text;

      // Skip if it's a command
      if (userMessage.startsWith('/')) {
        return;
      }

      try {
        // Send typing indicator
        await ctx.sendChatAction('typing');

        // Get LLM response
        const response = await this.llmService.generateResponse(userMessage);

        // Send response
        await ctx.reply(response);
      } catch (error) {
        console.error('Error processing message:', error);
        await ctx.reply('Sorry, I encountered an error processing your message.');
      }
    }
  }
}
