#!/bin/bash

# Test script to verify conversation history in Redis

echo "🧪 Testing Conversation History Implementation"
echo "=============================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check Redis is running
echo -n "Checking Redis connection... "
if docker exec murph-redis redis-cli ping > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Connected${NC}"
else
    echo -e "${RED}✗ Failed${NC}"
    echo "Please start Redis: docker run -d --name murph-redis -p 6379:6379 redis:alpine"
    exit 1
fi

# Check if there are any conversation keys
echo ""
echo "Current conversation keys in Redis:"
docker exec murph-redis redis-cli KEYS "conversation:user:*"

# Show count
KEY_COUNT=$(docker exec murph-redis redis-cli KEYS "conversation:user:*" | wc -l)
echo -e "\nTotal conversations: ${YELLOW}${KEY_COUNT}${NC}"

# If there are keys, show the first one
if [ $KEY_COUNT -gt 0 ]; then
    FIRST_KEY=$(docker exec murph-redis redis-cli KEYS "conversation:user:*" | head -1)
    echo ""
    echo "Sample conversation data:"
    echo "Key: $FIRST_KEY"
    docker exec murph-redis redis-cli GET "$FIRST_KEY" | python3 -m json.tool 2>/dev/null || docker exec murph-redis redis-cli GET "$FIRST_KEY"

    echo ""
    echo "TTL (Time To Live):"
    TTL=$(docker exec murph-redis redis-cli TTL "$FIRST_KEY")
    if [ "$TTL" -gt 0 ]; then
        HOURS=$((TTL / 3600))
        MINUTES=$(((TTL % 3600) / 60))
        echo -e "${GREEN}${HOURS}h ${MINUTES}m remaining${NC}"
    else
        echo -e "${RED}No TTL set or expired${NC}"
    fi
fi

echo ""
echo "=============================================="
echo "📝 Manual Testing Steps:"
echo ""
echo "1. Start the bot:"
echo "   bun run dev"
echo ""
echo "2. Send messages to your bot on Telegram:"
echo "   - 'Hi, my name is Alice'"
echo "   - 'What is my name?'"
echo ""
echo "3. Check conversation was stored:"
echo "   docker exec murph-redis redis-cli KEYS 'conversation:user:*'"
echo ""
echo "4. View conversation data:"
echo "   docker exec murph-redis redis-cli GET 'conversation:user:YOUR_USER_ID'"
echo ""
echo "5. Test /newsession command:"
echo "   - Send '/newsession' to bot"
echo "   - Ask 'What is my name?'"
echo "   - Bot should not remember"
echo ""
echo "=============================================="
