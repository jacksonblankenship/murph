import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { validateRequest } from 'twilio';

/**
 * Guard that verifies inbound HTTP requests originate from Twilio by
 * validating the `X-Twilio-Signature` header against the request URL and
 * form-encoded body.
 *
 * Twilio signs every webhook with HMAC-SHA1 using the account's Auth Token
 * as the secret key. Without this check, anyone who learns our public
 * webhook URL can drive the bot, forge status callbacks, or inject content
 * into our LLM via the `context` query parameter.
 *
 * Apply with `@UseGuards(TwilioSignatureGuard)` on any controller method
 * that handles a Twilio webhook (e.g. `/voice/twiml`, `/voice/status`).
 *
 * @see https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
@Injectable()
export class TwilioSignatureGuard implements CanActivate {
  private readonly authToken: string;
  private readonly serverUrl: string;

  constructor(
    private readonly logger: PinoLogger,
    private readonly configService: ConfigService,
  ) {
    this.logger.setContext(TwilioSignatureGuard.name);
    this.authToken = this.configService.get<string>('twilio.authToken');
    this.serverUrl = this.configService.get<string>('voice.serverUrl');
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.authToken) {
      throw new InternalServerErrorException(
        'TWILIO_AUTH_TOKEN is required for webhook signature validation',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const signature = request.header('X-Twilio-Signature');
    if (!signature) {
      this.logger.warn(
        { path: request.originalUrl },
        'Rejected webhook without X-Twilio-Signature header',
      );
      throw new ForbiddenException('Missing Twilio signature');
    }

    // Twilio signs the exact URL configured in the webhook + sorted POST
    // params. We use `voice.serverUrl` (our public base) joined with the
    // original path+query so we match what Twilio dialed, not whatever the
    // upstream proxy presents.
    const url = `${this.serverUrl}${request.originalUrl}`;
    const params = (request.body ?? {}) as Record<string, unknown>;

    const isValid = validateRequest(this.authToken, signature, url, params);
    if (!isValid) {
      this.logger.warn(
        { url, signature },
        'Rejected webhook with invalid Twilio signature',
      );
      throw new ForbiddenException('Invalid Twilio signature');
    }

    return true;
  }
}
