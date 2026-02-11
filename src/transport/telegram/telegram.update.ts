import { OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Command, Help, InjectBot, On, Start, Update } from 'nestjs-telegraf';
import { type Context, Telegraf } from 'telegraf';
import { BOT_MESSAGES } from '../../common/constants';
import { InboundService } from '../../inbound';
import { ConversationService } from '../../memory/conversation.service';
import { GardenTenderProcessor } from '../../sync/garden-tender.processor';
import { TranscriptionService } from '../../transcription';
import { UserProfileService } from '../../user-profile';

@Update()
export class TelegramUpdate implements OnModuleInit {
  constructor(
    private readonly logger: PinoLogger,
    @InjectBot() private readonly bot: Telegraf<Context>,
    private readonly conversationService: ConversationService,
    private readonly inboundService: InboundService,
    private readonly gardenTenderProcessor: GardenTenderProcessor,
    private readonly transcriptionService: TranscriptionService,
    private readonly userProfileService: UserProfileService,
  ) {
    this.logger.setContext(TelegramUpdate.name);
  }

  async onModuleInit() {
    await this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Welcome message' },
      { command: 'help', description: 'Show available commands' },
      { command: 'clear', description: 'Clear conversation history' },
      { command: 'tend', description: 'Trigger garden maintenance' },
      { command: 'timezone', description: 'Set your timezone' },
    ]);
    this.logger.info({}, 'Bot commands registered');
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

  @Command('tend')
  async tend(ctx: Context) {
    if (!ctx.from) {
      await ctx.reply('Unable to identify user.');
      return;
    }

    await this.gardenTenderProcessor.triggerManualTending();
    await ctx.reply(
      "Starting garden tending... I'll work on this in the background.",
    );
  }

  @Command('timezone')
  async timezone(ctx: Context) {
    if (!ctx.from) {
      await ctx.reply('Unable to identify user.');
      return;
    }

    if (!('text' in ctx.message)) {
      await ctx.reply('Unable to read message.');
      return;
    }

    const text = ctx.message.text;
    const parts = text.split(/\s+/);
    const timezoneArg = parts[1];

    if (!timezoneArg) {
      const currentTimezone = await this.userProfileService.getTimezone(
        ctx.from.id,
      );
      if (currentTimezone) {
        await ctx.reply(
          `Your timezone is set to: ${currentTimezone}\n\nTo change it, use: /timezone <IANA timezone>\nExample: /timezone America/New_York`,
        );
      } else {
        await ctx.reply(
          'No timezone set. Using UTC by default.\n\nTo set your timezone, use: /timezone <IANA timezone>\nExample: /timezone America/New_York',
        );
      }
      return;
    }

    // Validate the timezone by attempting to use it
    if (!this.isValidTimezone(timezoneArg)) {
      await ctx.reply(
        `Invalid timezone: ${timezoneArg}\n\nPlease use an IANA timezone identifier.\nExamples: America/New_York, Europe/London, Asia/Tokyo`,
      );
      return;
    }

    await this.userProfileService.setTimezone(ctx.from.id, timezoneArg);
    await ctx.reply(`Timezone updated to: ${timezoneArg}`);
  }

  /**
   * Validates an IANA timezone identifier.
   */
  private isValidTimezone(timezone: string): boolean {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      return true;
    } catch {
      return false;
    }
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

    try {
      // Send typing indicator immediately
      await ctx.sendChatAction('typing');

      // Enqueue for debounced processing
      await this.inboundService.enqueue({
        userId: ctx.from.id,
        chatId: ctx.chat.id,
        text: userMessage,
        messageId: ctx.message.message_id,
        source: 'telegram',
      });
    } catch (error) {
      this.logger.error({ err: error }, 'Error enqueuing message');
      await ctx.reply('Sorry, I encountered an error processing your message.');
    }
  }

  @On('voice')
  async onVoice(ctx: Context) {
    if (!('voice' in ctx.message) || !ctx.from || !ctx.chat) {
      return;
    }

    const voice = ctx.message.voice;

    try {
      // Send typing indicator immediately
      await ctx.sendChatAction('typing');

      // Download the voice file
      const fileLink = await ctx.telegram.getFileLink(voice.file_id);
      const response = await fetch(fileLink.href);

      if (!response.ok) {
        this.logger.error(
          { status: response.status, fileId: voice.file_id },
          'Failed to download voice file',
        );
        await ctx.reply(
          'I had trouble downloading your voice message. Please try again.',
        );
        return;
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());

      // Transcribe the audio
      const result = await this.transcriptionService.transcribe(audioBuffer, {
        fileUniqueId: voice.file_unique_id,
        filename: `voice_${voice.file_unique_id}.ogg`,
      });

      if (!result.success) {
        this.logger.warn(
          { fileUniqueId: voice.file_unique_id, error: result.error },
          'Voice transcription failed',
        );
        await ctx.reply(
          "I couldn't understand the audio. Could you try again?",
        );
        return;
      }

      this.logger.info(
        { fileUniqueId: voice.file_unique_id, textLength: result.text.length },
        'Voice message transcribed',
      );

      // Enqueue transcribed text for debounced processing
      await this.inboundService.enqueue({
        userId: ctx.from.id,
        chatId: ctx.chat.id,
        text: result.text,
        messageId: ctx.message.message_id,
        source: 'telegram',
      });
    } catch (error) {
      this.logger.error({ err: error }, 'Error processing voice message');
      await ctx.reply(
        'I had trouble processing your voice message. Please try again.',
      );
    }
  }
}
