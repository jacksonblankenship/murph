import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class LlmService {
  private anthropic: Anthropic;

  constructor(private configService: ConfigService) {
    this.anthropic = new Anthropic({
      apiKey: this.configService.get<string>('ANTHROPIC_API_KEY'),
    });
  }

  async generateResponse(userMessage: string): Promise<string> {
    try {
      const message = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: userMessage,
          },
        ],
      });

      const textContent = message.content.find((block) => block.type === 'text');
      return textContent?.type === 'text'
        ? textContent.text
        : 'Sorry, I could not generate a response.';
    } catch (error) {
      console.error('Error calling Anthropic API:', error);
      throw error;
    }
  }
}
