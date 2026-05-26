import { Injectable } from '@nestjs/common';
import type { ToolFactory } from '../channel.types';
import { SchedulingToolFactory } from './scheduling.factory';
import { SeedToolFactory } from './seed.factory';
import { TimeToolFactory } from './time.factory';
import { WebSearchToolFactory } from './web-search.factory';

/**
 * Tools available to every channel where a human is on the other side of
 * the conversation — voice calls and Telegram chats today.
 *
 * Channels add their own transport-specific tools on top of this bundle
 * (e.g. `hang_up` for voice, `voice_call` for Telegram). Background
 * channels like `scheduled-proactive` and `garden-tender` intentionally
 * do not use this bundle.
 */
@Injectable()
export class ConversationalToolBundle {
  constructor(
    private readonly timeToolFactory: TimeToolFactory,
    private readonly seedToolFactory: SeedToolFactory,
    private readonly webSearchToolFactory: WebSearchToolFactory,
    private readonly schedulingToolFactory: SchedulingToolFactory,
  ) {}

  /**
   * Returns the tool factories in the order they should be registered.
   */
  factories(): ToolFactory[] {
    return [
      this.timeToolFactory,
      this.seedToolFactory,
      this.webSearchToolFactory,
      this.schedulingToolFactory,
    ];
  }
}
