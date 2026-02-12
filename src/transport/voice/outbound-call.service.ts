import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import twilio from 'twilio';

/** Max characters of context to include in log messages. */
const LOG_PREVIEW_LENGTH = 100;

/** Twilio call lifecycle events to receive status callbacks for. */
const STATUS_CALLBACK_EVENTS = [
  'initiated',
  'ringing',
  'answered',
  'completed',
];

/**
 * Service for initiating outbound voice calls via Twilio.
 *
 * Calls the user's phone number and directs Twilio to fetch TwiML
 * from our voice webhook, passing optional call context as a query parameter.
 */
@Injectable()
export class OutboundCallService {
  private readonly client: ReturnType<typeof twilio>;
  private readonly twilioPhoneNumber: string;
  private readonly userPhone: string;
  private readonly serverUrl: string;

  constructor(
    private readonly logger: PinoLogger,
    private readonly configService: ConfigService,
  ) {
    this.logger.setContext(OutboundCallService.name);

    const accountSid = this.configService.get<string>('twilio.accountSid');
    const authToken = this.configService.get<string>('twilio.authToken');
    this.client = twilio(accountSid, authToken);

    this.twilioPhoneNumber =
      this.configService.get<string>('twilio.phoneNumber');
    this.userPhone = this.configService.get<string>('voice.userPhone');
    this.serverUrl = this.configService.get<string>('voice.serverUrl');
  }

  /**
   * Initiates an outbound call to the configured user phone number.
   *
   * Encodes `userId` and `context` as query params on the status callback URL
   * so the status endpoint can emit a fallback message if the call fails.
   *
   * @param userId - Telegram user ID for fallback message routing
   * @param context - Optional context describing why Murph is calling
   * @returns The Twilio call SID
   */
  async callUser(userId: number, context?: string): Promise<string> {
    const twimlUrl = context
      ? `${this.serverUrl}/voice/twiml?context=${encodeURIComponent(context)}`
      : `${this.serverUrl}/voice/twiml`;

    this.logger.info(
      {
        to: this.userPhone,
        twimlUrl,
        context: context?.substring(0, LOG_PREVIEW_LENGTH),
      },
      'Initiating outbound call',
    );

    const statusParams = new URLSearchParams({ userId: String(userId) });
    if (context) {
      statusParams.set('context', context);
    }
    const statusCallbackUrl = `${this.serverUrl}/voice/status?${statusParams.toString()}`;

    const call = await this.client.calls.create({
      to: this.userPhone,
      from: this.twilioPhoneNumber,
      url: twimlUrl,
      statusCallback: statusCallbackUrl,
      statusCallbackEvent: STATUS_CALLBACK_EVENTS,
    });

    this.logger.info({ callSid: call.sid }, 'Outbound call created');
    return call.sid;
  }
}
