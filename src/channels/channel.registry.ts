import { Injectable, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import type { ChannelConfig } from './channel.types';

/**
 * Token for injecting channel presets.
 * Presets register themselves with this token.
 */
export const CHANNEL_PRESET = Symbol('CHANNEL_PRESET');

/**
 * Interface for channel preset providers.
 * Presets create channel configurations using the builder pattern.
 */
export interface ChannelPreset {
  /** Build the channel configuration */
  build(): ChannelConfig;
}

/**
 * Central registry for channel configurations.
 *
 * Stores and retrieves channel configs by ID. Presets are registered
 * automatically on module initialization.
 */
@Injectable()
export class ChannelRegistry implements OnModuleInit {
  private readonly channels = new Map<string, ChannelConfig>();

  constructor(
    private readonly logger: PinoLogger,
    private readonly moduleRef: ModuleRef,
  ) {
    this.logger.setContext(ChannelRegistry.name);
  }

  async onModuleInit(): Promise<void> {
    // Presets are registered manually via register() method
    // This allows for explicit control over registration order
    this.logger.info(
      { count: this.channels.size },
      'Channel registry initialized',
    );
  }

  /**
   * Register a channel configuration.
   * @param config The channel configuration to register
   * @throws Error if a channel with the same ID is already registered
   */
  register(config: ChannelConfig): void {
    if (this.channels.has(config.id)) {
      throw new Error(`Channel "${config.id}" is already registered`);
    }
    this.channels.set(config.id, config);
    this.logger.debug({ channelId: config.id }, 'Registered channel');
  }

  /**
   * Get a channel configuration by ID.
   * @param id The channel ID
   * @returns The channel configuration
   * @throws Error if the channel is not found
   */
  get(id: string): ChannelConfig {
    const config = this.channels.get(id);
    if (!config) {
      throw new Error(
        `Channel "${id}" not found. Available: ${this.listIds().join(', ')}`,
      );
    }
    return config;
  }

  /**
   * Check if a channel exists.
   * @param id The channel ID
   */
  has(id: string): boolean {
    return this.channels.has(id);
  }

  /**
   * List all registered channel IDs.
   */
  listIds(): string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Get the count of registered channels.
   */
  get size(): number {
    return this.channels.size;
  }
}
