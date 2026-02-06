import { Command, Help, Start, Update } from 'nestjs-telegraf';
import type { Context } from 'telegraf';
import { BOT_MESSAGES } from '../common/constants';

@Update()
export class BotUpdate {
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
}
