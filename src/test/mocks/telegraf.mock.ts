/**
 * Creates a mock Telegraf bot.
 */
export function createMockTelegraf() {
  const sentMessages: Array<{ chatId: number; text: string }> = [];
  const chatActions: Array<{ chatId: number; action: string }> = [];
  let shouldFail = false;

  return {
    sentMessages,
    chatActions,

    setShouldFail(value: boolean) {
      shouldFail = value;
    },

    telegram: {
      async sendMessage(chatId: number, text: string) {
        if (shouldFail) {
          throw new Error('Telegram API error');
        }
        sentMessages.push({ chatId, text });
        return { message_id: Date.now(), chat: { id: chatId }, text };
      },

      async sendChatAction(chatId: number, action: string) {
        if (shouldFail) {
          throw new Error('Telegram API error');
        }
        chatActions.push({ chatId, action });
        return true;
      },
    },

    clear() {
      sentMessages.length = 0;
      chatActions.length = 0;
      shouldFail = false;
    },
  };
}

export type MockTelegraf = ReturnType<typeof createMockTelegraf>;
