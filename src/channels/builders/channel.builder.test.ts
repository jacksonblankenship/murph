import { describe, expect, test } from 'bun:test';
import type {
  ContextEnricher,
  MessageTransformer,
  OutputHandler,
  ToolFactory,
} from '../channel.types';
import { ChannelBuilder } from './channel.builder';

describe('ChannelBuilder', () => {
  const mockTransformer: MessageTransformer = {
    transform: (msg: string) => `[transformed] ${msg}`,
  };

  const mockEnricher: ContextEnricher = {
    enrich: async () => ({ contextAdditions: 'enriched context' }),
  };

  const mockOutput: OutputHandler = {
    send: async () => {},
  };

  const mockToolFactory: ToolFactory = {
    create: () => ({}),
  };

  describe('build', () => {
    test('creates channel config with all components', () => {
      const config = new ChannelBuilder('test-channel')
        .withSystemPrompt('Test prompt')
        .addTransformer(mockTransformer)
        .addEnricher(mockEnricher)
        .addTools(mockToolFactory)
        .addOutput(mockOutput)
        .build();

      expect(config.id).toBe('test-channel');
      expect(config.systemPrompt).toBe('Test prompt');
      expect(config.transformers).toHaveLength(1);
      expect(config.enrichers).toHaveLength(1);
      expect(config.toolFactories).toHaveLength(1);
      expect(config.outputs).toHaveLength(1);
    });

    test('throws error if system prompt is missing', () => {
      expect(() => {
        new ChannelBuilder('test-channel').build();
      }).toThrow('Channel "test-channel" requires a system prompt');
    });

    test('allows empty component arrays', () => {
      const config = new ChannelBuilder('minimal-channel')
        .withSystemPrompt('Just a prompt')
        .build();

      expect(config.transformers).toHaveLength(0);
      expect(config.enrichers).toHaveLength(0);
      expect(config.toolFactories).toHaveLength(0);
      expect(config.outputs).toHaveLength(0);
    });

    test('chains multiple transformers in order', () => {
      const transformer1: MessageTransformer = {
        transform: (msg: string) => `[1] ${msg}`,
      };
      const transformer2: MessageTransformer = {
        transform: (msg: string) => `[2] ${msg}`,
      };

      const config = new ChannelBuilder('chain-channel')
        .withSystemPrompt('Prompt')
        .addTransformer(transformer1)
        .addTransformer(transformer2)
        .build();

      expect(config.transformers).toHaveLength(2);
      expect(config.transformers[0]).toBe(transformer1);
      expect(config.transformers[1]).toBe(transformer2);
    });

    test('returns independent config copies', () => {
      const builder = new ChannelBuilder('copy-channel')
        .withSystemPrompt('Prompt')
        .addEnricher(mockEnricher);

      const config1 = builder.build();
      const config2 = builder.build();

      expect(config1.enrichers).not.toBe(config2.enrichers);
      expect(config1.enrichers).toEqual(config2.enrichers);
    });
  });

  describe('fluent API', () => {
    test('returns builder instance for chaining', () => {
      const builder = new ChannelBuilder('fluent-channel');

      expect(builder.withSystemPrompt('Prompt')).toBe(builder);
      expect(builder.addTransformer(mockTransformer)).toBe(builder);
      expect(builder.addEnricher(mockEnricher)).toBe(builder);
      expect(builder.addTools(mockToolFactory)).toBe(builder);
      expect(builder.addOutput(mockOutput)).toBe(builder);
    });
  });
});
