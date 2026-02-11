export const configuration = () => ({
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  exa: {
    apiKey: process.env.EXA_API_KEY,
  },
  messages: {
    debounceMs: Number.parseInt(
      process.env.USER_MESSAGE_DEBOUNCE_MS || '2000',
      10,
    ),
  },
  vault: {
    path: process.env.VAULT_PATH || './vault',
    excludePatterns: (
      process.env.VAULT_EXCLUDE_PATTERNS ||
      '.obsidian,Templates,*.sync-conflict-*'
    ).split(','),
  },
  vector: {
    qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333',
    collectionName: process.env.QDRANT_COLLECTION || 'obsidian-notes',
    syncIntervalMs: Number.parseInt(
      process.env.VECTOR_SYNC_INTERVAL_MS || '300000',
      10,
    ),
    chunkSize: Number.parseInt(process.env.VECTOR_CHUNK_SIZE || '500', 10),
    chunkOverlap: Number.parseInt(process.env.VECTOR_CHUNK_OVERLAP || '50', 10),
    autoInjectThreshold: Number.parseFloat(
      process.env.VECTOR_AUTO_INJECT_THRESHOLD || '0.75',
    ),
    searchLimit: Number.parseInt(process.env.VECTOR_SEARCH_LIMIT || '5', 10),
  },
  gardenTending: {
    cronSchedule: process.env.GARDEN_TENDING_CRON || '0 3 * * *', // Daily at 3am
    enabled: process.env.GARDEN_TENDING_ENABLED !== 'false',
  },
});
