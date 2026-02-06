# Redis Setup & Conversation History Testing

## Quick Start with Redis

### Option 1: Run Redis with Docker (Recommended)

```bash
# Start Redis in a Docker container
docker run -d --name murph-redis -p 6379:6379 redis:alpine

# Verify Redis is running
docker ps | grep murph-redis

# Test Redis connection
redis-cli ping
# Expected output: PONG
```

### Option 2: Install Redis Locally

**macOS:**
```bash
brew install redis
redis-server
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get update
sudo apt-get install redis-server
sudo systemctl start redis-server
```

## Running the Bot

```bash
# Start the bot in development mode
bun run dev
```

## Testing Conversation History

### Test 1: Basic Conversation Memory

1. Start the bot: `bun run dev`
2. Open Telegram and message your bot: "Hi, my name is Alice"
3. Send follow-up message: "What's my name?"
   - ✅ Expected: Bot should remember and say "Alice"
4. Ask: "What did I just tell you?"
   - ✅ Expected: Bot should recall the conversation

### Test 2: Session Reset

1. Have a conversation with the bot
2. Send command: `/newsession`
   - ✅ Expected: Confirmation message "✨ Started a new conversation session! Previous messages have been cleared."
3. Ask: "What's my name?" or "What did we talk about?"
   - ✅ Expected: Bot should not remember previous conversation

### Test 3: Message Limit (50 messages)

1. Send many messages (60+) in a conversation
2. Check Redis to verify only last 50 messages are stored:
```bash
redis-cli
GET conversation:user:YOUR_USER_ID
# Should show max 50 messages
```

### Test 4: TTL Expiration (24 hours)

**Manual test (simulate expiration):**
```bash
# After having a conversation, manually expire the key
redis-cli
EXPIRE conversation:user:YOUR_USER_ID 1
# Wait 2 seconds
GET conversation:user:YOUR_USER_ID
# Expected: (nil) - key expired
```

## Redis CLI Commands for Debugging

```bash
# Connect to Redis
redis-cli

# List all conversation keys
KEYS conversation:user:*

# View a specific conversation
GET conversation:user:123456

# Check TTL for a key
TTL conversation:user:123456

# Manually delete a conversation
DEL conversation:user:123456

# Clear all data (use carefully!)
FLUSHALL
```

## Monitoring Conversation Data

**View formatted conversation:**
```bash
# Replace 123456 with your Telegram user ID
redis-cli GET conversation:user:123456 | python3 -m json.tool
```

**Check memory usage:**
```bash
redis-cli INFO memory
```

## Troubleshooting

### Bot can't connect to Redis

**Error:** "Redis connection error: connect ECONNREFUSED"

**Solutions:**
1. Check Redis is running: `docker ps` or `redis-cli ping`
2. Check .env file has correct Redis configuration:
   ```
   REDIS_HOST=localhost
   REDIS_PORT=6379
   ```
3. Restart Redis: `docker restart murph-redis`

### Conversation not persisting

**Check:**
1. Verify key exists: `redis-cli KEYS conversation:user:*`
2. Check TTL: `redis-cli TTL conversation:user:YOUR_ID`
3. View bot logs for errors
4. Check user ID is being extracted correctly from Telegram messages

### Memory issues

**Monitor:**
```bash
# Check Redis memory usage
redis-cli INFO memory | grep used_memory_human

# Check number of keys
redis-cli DBSIZE
```

## Clean Up

```bash
# Stop and remove Redis container
docker stop murph-redis
docker rm murph-redis
```

## Architecture Summary

### Conversation Flow

1. **User sends message** → BotUpdate receives text
2. **Extract user ID** → `ctx.from.id`
3. **Retrieve history** → ConversationService.getConversation(userId)
4. **Generate response** → LlmService.generateResponse(message, history)
5. **Store messages** → ConversationService.addMessage() for both user & assistant
6. **Reset TTL** → Automatic on each message (24 hours)

### Session Management Layers

1. **Message limit**: 50 messages max (25 exchanges)
2. **TTL**: 24 hours of inactivity
3. **Manual reset**: `/newsession` command
4. **Automatic pruning**: Removes oldest messages when limit exceeded

### Redis Key Format

```
conversation:user:{userId}
```

**Value format:**
```json
[
  {
    "role": "user",
    "content": "Hi, my name is Alice",
    "timestamp": 1738800000000
  },
  {
    "role": "assistant",
    "content": "Hello Alice! Nice to meet you.",
    "timestamp": 1738800001000
  }
]
```
