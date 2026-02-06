# NestJS Telegram Bot - Hello World

A simple "Hello World" Telegram bot built with NestJS and nestjs-telegraf, running on Bun.

## Features

- 🤖 Simple command-based bot
- ⚡ Built with NestJS framework
- 🚀 Runs on Bun runtime
- 📝 TypeScript support
- ✨ Linting with Biome

## Available Commands

- `/start` - Get a welcome message with "Hello World!"
- `/hello` - Receive a simple "Hello World!" response
- `/help` - List all available commands

## Setup Instructions

### 1. Install Dependencies

```bash
bun install
```

### 2. Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow the prompts
3. Choose a name for your bot (e.g., "My Hello World Bot")
4. Choose a username for your bot (must end in 'bot', e.g., "my_hello_world_bot")
5. Copy the bot token provided by BotFather

### 3. Configure Environment Variables

```bash
# Copy the example env file
cp .env.example .env

# Edit .env and add your bot token
# TELEGRAM_BOT_TOKEN=your_bot_token_here
```

### 4. Run the Bot

**Development mode (with hot reload):**
```bash
bun run dev
```

**Production mode:**
```bash
# Build the project
bun run build

# Run the compiled code
bun run start
```

## Project Structure

```
src/
├── main.ts                 # Application bootstrap
├── app.module.ts          # Root module with TelegrafModule config
├── bot/
│   ├── bot.module.ts      # Bot feature module
│   └── bot.update.ts      # Command handlers
├── config/
│   └── configuration.ts   # Configuration factory
└── common/
    └── constants.ts       # Bot messages and constants
```

## Testing the Bot

1. Find your bot in Telegram by searching for its username
2. Start a chat with the bot
3. Try the following commands:
   - Send `/start` → You should receive a welcome message
   - Send `/hello` → You should receive "Hello World! 🌍"
   - Send `/help` → You should see a list of available commands

## Development

### Linting

```bash
# Check for linting issues
bun run lint

# Auto-fix linting issues
bun run lint:fix
```

### Formatting

```bash
# Format code with Biome
bun run format
```

## Tech Stack

- **Framework:** NestJS
- **Bot Library:** nestjs-telegraf (wraps Telegraf)
- **Runtime:** Bun 1.3.6
- **Language:** TypeScript
- **Linter/Formatter:** Biome

## License

MIT
