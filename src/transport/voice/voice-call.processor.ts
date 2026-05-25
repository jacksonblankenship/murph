import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { OutboundCallService } from './outbound-call.service';

/** Max characters of context to include in log messages. */
const LOG_PREVIEW_LENGTH = 100;

/**
 * Job data for outbound voice calls.
 */
export interface VoiceCallJobData {
  userId: number;
  context?: string;
}

/**
 * BullMQ processor for the `voice-calls` queue.
 *
 * Invoked by:
 * - The `call_me` tool (immediate calls)
 * - The task processor (scheduled calls with `action: 'call'`)
 */
@Processor('voice-calls')
export class VoiceCallProcessor extends WorkerHost {
  constructor(
    private readonly logger: PinoLogger,
    private readonly outboundCallService: OutboundCallService,
  ) {
    super();
    this.logger.setContext(VoiceCallProcessor.name);
  }

  /**
   * Process a voice call job by initiating an outbound call.
   *
   * Errors thrown by Twilio (invalid URL, unverified number, auth failure)
   * are logged before re-throwing so BullMQ's retry/failure machinery has
   * something more actionable than a swallowed exception.
   */
  async process(job: Job<VoiceCallJobData>): Promise<string> {
    const { userId, context } = job.data;

    // `callContext` rather than `context` — pino treats `context` as the
    // logger's class-name slot, so using it here would clobber the
    // `VoiceCallProcessor` tag on every log line.
    this.logger.info(
      { userId, callContext: context?.substring(0, LOG_PREVIEW_LENGTH) },
      'Processing outbound call job',
    );

    try {
      const callSid = await this.outboundCallService.callUser(userId, context);
      this.logger.info({ callSid, userId }, 'Outbound call initiated');
      return callSid;
    } catch (err) {
      this.logger.error(
        {
          err,
          userId,
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts,
        },
        'Outbound call failed',
      );
      throw err;
    }
  }
}
