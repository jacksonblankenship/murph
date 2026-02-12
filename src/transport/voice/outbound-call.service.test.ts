import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test/mocks/pino-logger.mock';
import { OutboundCallService } from './outbound-call.service';

describe('OutboundCallService', () => {
  let service: OutboundCallService;
  let mockTwilioClient: {
    calls: { create: ReturnType<typeof mock> };
  };

  beforeEach(() => {
    const mockConfigService = {
      get: mock((key: string) => {
        const config: Record<string, string> = {
          'twilio.accountSid': 'AC123',
          'twilio.authToken': 'token123',
          'twilio.phoneNumber': '+15551234567',
          'voice.userPhone': '+15559876543',
          'voice.serverUrl': 'https://example.ngrok.io',
        };
        return config[key];
      }),
    };

    service = new OutboundCallService(
      createMockLogger(),
      mockConfigService as never,
    );

    // Inject mock Twilio client
    mockTwilioClient = {
      calls: {
        create: mock(() => Promise.resolve({ sid: 'CA-new-call' })),
      },
    };
    (service as unknown as { client: typeof mockTwilioClient }).client =
      mockTwilioClient;
  });

  test('creates call with correct parameters and status callback', async () => {
    const callSid = await service.callUser(42, 'Check in about project');

    expect(mockTwilioClient.calls.create).toHaveBeenCalledTimes(1);
    const createArgs = mockTwilioClient.calls.create.mock.calls[0][0];
    expect(createArgs.to).toBe('+15559876543');
    expect(createArgs.from).toBe('+15551234567');
    expect(createArgs.url).toContain('https://example.ngrok.io/voice/twiml');
    expect(createArgs.url).toContain('context=Check%20in%20about%20project');
    expect(createArgs.statusCallback).toContain(
      'https://example.ngrok.io/voice/status',
    );
    expect(createArgs.statusCallback).toContain('userId=42');
    expect(createArgs.statusCallback).toContain(
      'context=Check+in+about+project',
    );
    expect(createArgs.statusCallbackEvent).toEqual([
      'initiated',
      'ringing',
      'answered',
      'completed',
    ]);
    expect(callSid).toBe('CA-new-call');
  });

  test('creates call without context parameter', async () => {
    await service.callUser(42);

    const createArgs = mockTwilioClient.calls.create.mock.calls[0][0];
    expect(createArgs.url).toBe('https://example.ngrok.io/voice/twiml');
    expect(createArgs.url).not.toContain('context');
    expect(createArgs.statusCallback).toContain('userId=42');
    expect(createArgs.statusCallback).not.toContain('context=');
    expect(createArgs.statusCallbackEvent).toEqual([
      'initiated',
      'ringing',
      'answered',
      'completed',
    ]);
  });
});
