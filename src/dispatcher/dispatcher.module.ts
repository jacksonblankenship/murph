import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentDispatcher } from './agent-dispatcher.service';

/**
 * Global module providing the AgentDispatcher.
 *
 * Modules register their queues via `dispatcher.registerQueue()` on init.
 * Tool factories and processors dispatch jobs without direct queue references.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [AgentDispatcher],
  exports: [AgentDispatcher],
})
export class DispatcherModule {}
