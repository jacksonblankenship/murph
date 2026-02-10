import { beforeEach, describe, expect, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/pino-logger.mock';
import { ChannelRegistry } from './channel.registry';
import type { ChannelConfig } from './channel.types';

describe('ChannelRegistry', () => {
  let registry: ChannelRegistry;

  const createMockConfig = (id: string): ChannelConfig => ({
    id,
    systemPrompt: `Prompt for ${id}`,
    transformers: [],
    enrichers: [],
    toolFactories: [],
    outputs: [],
  });

  beforeEach(() => {
    registry = new ChannelRegistry(createMockLogger(), null as never);
  });

  describe('register', () => {
    test('registers a channel config', () => {
      const config = createMockConfig('test-channel');

      registry.register(config);

      expect(registry.has('test-channel')).toBe(true);
    });

    test('throws error on duplicate registration', () => {
      const config = createMockConfig('duplicate');

      registry.register(config);

      expect(() => {
        registry.register(config);
      }).toThrow('Channel "duplicate" is already registered');
    });

    test('allows registering multiple different channels', () => {
      registry.register(createMockConfig('channel-1'));
      registry.register(createMockConfig('channel-2'));
      registry.register(createMockConfig('channel-3'));

      expect(registry.size).toBe(3);
    });
  });

  describe('get', () => {
    test('returns registered channel config', () => {
      const config = createMockConfig('my-channel');
      registry.register(config);

      const retrieved = registry.get('my-channel');

      expect(retrieved).toBe(config);
    });

    test('throws error for non-existent channel', () => {
      registry.register(createMockConfig('existing'));

      expect(() => {
        registry.get('non-existent');
      }).toThrow('Channel "non-existent" not found. Available: existing');
    });

    test('lists all available channels in error message', () => {
      registry.register(createMockConfig('alpha'));
      registry.register(createMockConfig('beta'));

      expect(() => {
        registry.get('gamma');
      }).toThrow('Available: alpha, beta');
    });
  });

  describe('has', () => {
    test('returns true for registered channel', () => {
      registry.register(createMockConfig('exists'));

      expect(registry.has('exists')).toBe(true);
    });

    test('returns false for non-existent channel', () => {
      expect(registry.has('missing')).toBe(false);
    });
  });

  describe('listIds', () => {
    test('returns empty array when no channels registered', () => {
      expect(registry.listIds()).toEqual([]);
    });

    test('returns all registered channel IDs', () => {
      registry.register(createMockConfig('first'));
      registry.register(createMockConfig('second'));

      const ids = registry.listIds();

      expect(ids).toContain('first');
      expect(ids).toContain('second');
      expect(ids).toHaveLength(2);
    });
  });

  describe('size', () => {
    test('returns 0 when empty', () => {
      expect(registry.size).toBe(0);
    });

    test('returns correct count after registration', () => {
      registry.register(createMockConfig('one'));
      registry.register(createMockConfig('two'));

      expect(registry.size).toBe(2);
    });
  });
});
