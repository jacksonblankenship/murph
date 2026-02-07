import { Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectBot } from 'nestjs-telegraf';
import { Command, Help, On, Start, Update } from 'nestjs-telegraf';
import { type Context, Telegraf } from 'telegraf';
import { AppClsService } from '../../common/cls.service';
import { BOT_MESSAGES } from '../../common/constants';
import { Events, type UserMessageEvent } from '../../common/events';
import { ConversationService } from '../../memory/conversation.service';

@Update()
export class TelegramUpdate implements OnModuleInit {
  private readonly logger = new Logger(TelegramUpdate.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf<Context>,
    private readonly conversationService: ConversationService,
    private readonly eventEmitter: EventEmitter2,
    private readonly clsService: AppClsService,
  ) {}

  async onModuleInit() {
    await this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Welcome message' },
      { command: 'help', description: 'Show available commands' },
      { command: 'clear', description: 'Clear conversation history' },
    ]);
    this.logger.log('Bot commands registered');
  }

  @Start()
  async start(ctx: Context) {
    await ctx.replyWithHTML(BOT_MESSAGES.START);
  }

  @Help()
  async help(ctx: Context) {
    await ctx.replyWithHTML(BOT_MESSAGES.HELP);
  }

  @Command('clear')
  async clear(ctx: Context) {
    if (!ctx.from) {
      await ctx.reply('Unable to identify user.');
      return;
    }

    const userId = ctx.from.id;
    await this.conversationService.clearConversation(userId);
    await ctx.reply(BOT_MESSAGES.CLEAR);
  }

  @On('text')
  async onText(ctx: Context) {
    if (!('text' in ctx.message) || !ctx.from || !ctx.chat) {
      return;
    }

    const userMessage = ctx.message.text;

    // Skip if it's a command
    if (userMessage.startsWith('/')) {
      return;
    }

    // Set user context in CLS for downstream services
    this.clsService.setUserId(ctx.from.id);
    this.clsService.setChatId(ctx.chat.id);

    try {
      // Send typing indicator immediately
      await ctx.sendChatAction('typing');

      // Emit user message event for processing
      const event: UserMessageEvent = {
        userId: ctx.from.id,
        text: userMessage,
        messageId: ctx.message.message_id,
        chatId: ctx.chat.id,
      };

      this.eventEmitter.emit(Events.USER_MESSAGE, event);
    } catch (error) {
      this.logger.error('Error emitting message event:', error);
      await ctx.reply('Sorry, I encountered an error processing your message.');
    }
  }
}
