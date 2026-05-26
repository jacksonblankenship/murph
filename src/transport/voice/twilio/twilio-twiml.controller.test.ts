import { describe, expect, test } from 'bun:test';
import type { ConfigService } from '@nestjs/config';
import type { AgentDispatcher } from '../../../dispatcher';
import { createMockLogger } from '../../../test/mocks/pino-logger.mock';
import { TwilioTwimlController } from './twilio-twiml.controller';

function makeController(): TwilioTwimlController {
  const config = {
    get: (key: string) =>
      key === 'voice.serverUrl' ? 'https://example.test' : undefined,
  } as unknown as ConfigService;
  const dispatcher = {} as AgentDispatcher;
  return new TwilioTwimlController(createMockLogger(), config, dispatcher);
}

describe('TwilioTwimlController.handleTwiml', () => {
  test('renders ConversationRelay attributes in camelCase Twilio expects', () => {
    const controller = makeController();

    const xml = controller.handleTwiml();

    // Twilio's XML validator (warning 12200) silently drops unknown
    // lowercase variants like `speechtimeout` / `ignorebackchannel`,
    // so the settings must be emitted in canonical camelCase.
    expect(xml).toContain('speechTimeout="1500"');
    expect(xml).toContain('ignoreBackchannel="true"');
    expect(xml).not.toContain('speechtimeout=');
    expect(xml).not.toContain('ignorebackchannel=');
  });

  test('omits welcomeGreeting for outbound (context-bearing) calls', () => {
    const controller = makeController();

    const xml = controller.handleTwiml('Jackson requested another call');

    expect(xml).not.toContain('welcomeGreeting');
    expect(xml).toContain(
      '<Parameter name="callContext" value="Jackson requested another call"/>',
    );
  });

  test('includes welcomeGreeting for inbound calls', () => {
    const controller = makeController();

    const xml = controller.handleTwiml();

    expect(xml).toContain('welcomeGreeting="Hey!"');
  });
});
