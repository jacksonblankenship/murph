import { beforeEach, describe, expect, test } from 'bun:test';
import { PromptService } from './prompt.service';

describe('PromptService', () => {
  let service: PromptService;

  beforeEach(() => {
    service = new PromptService();
  });

  describe('get', () => {
    test('loads user-direct prompt without error', () => {
      expect(() => service.get('user-direct')).not.toThrow();
    });

    test('loads scheduled-proactive prompt without error', () => {
      expect(() => service.get('scheduled-proactive')).not.toThrow();
    });

    test('loads garden-curator prompt without error', () => {
      expect(() => service.get('garden-curator')).not.toThrow();
    });

    test('throws for unknown prompt name', () => {
      expect(() => service.get('nonexistent' as never)).toThrow(
        'Prompt not found: nonexistent',
      );
    });
  });

  describe('partials', () => {
    test('user-direct resolves philosophy partials', () => {
      const prompt = service.get('user-direct');
      expect(prompt).toContain('Digital Garden Philosophy');
      expect(prompt).toContain('Growth Stages');
    });

    test('scheduled-proactive resolves philosophy partials', () => {
      const prompt = service.get('scheduled-proactive');
      expect(prompt).toContain('Digital Garden Philosophy');
      expect(prompt).toContain('Growth Stages');
    });

    test('garden-curator resolves all partial types', () => {
      const prompt = service.get('garden-curator');
      expect(prompt).toContain('Digital Garden Philosophy');
      expect(prompt).toContain('Preservation Rules');
      expect(prompt).toContain('Formatting Rules');
      expect(prompt).toContain('Deduplication Workflow');
      expect(prompt).toContain('Growth Stages');
      expect(prompt).toContain('Tending vs Revising');
      expect(prompt).toContain('Structure Notes');
    });
  });

  describe('render', () => {
    test('substitutes variables in garden-curator prompt', () => {
      const prompt = service.render('garden-curator', { today: '2025-02-07' });
      expect(prompt).toContain("Today's date: 2025-02-07");
    });

    test('handles missing variables gracefully', () => {
      const prompt = service.render('garden-curator', {});
      expect(prompt).toContain("Today's date:");
    });

    test('get is equivalent to render with empty vars', () => {
      const getResult = service.get('garden-curator');
      const renderResult = service.render('garden-curator', {});
      expect(getResult).toBe(renderResult);
    });
  });

  describe('prompt content', () => {
    test('user-direct contains Murph identity', () => {
      const prompt = service.get('user-direct');
      expect(prompt).toContain('You are Murph');
    });

    test('user-direct contains knowledge capture section', () => {
      const prompt = service.get('user-direct');
      expect(prompt).toContain('Knowledge Capture');
      expect(prompt).toContain('search_similar');
    });

    test('scheduled-proactive mentions scheduled task context', () => {
      const prompt = service.get('scheduled-proactive');
      expect(prompt).toContain('SCHEDULED TASK');
    });

    test('garden-curator is the sole organizer', () => {
      const prompt = service.get('garden-curator');
      expect(prompt).toContain('garden tender');
      expect(prompt).toContain('organization and maintenance');
    });

    test('garden-curator contains all tool descriptions', () => {
      const prompt = service.get('garden-curator');
      expect(prompt).toContain('read_note');
      expect(prompt).toContain('rewrite_note');
      expect(prompt).toContain('merge_notes');
      expect(prompt).toContain('split_note');
      expect(prompt).toContain('create_note');
      expect(prompt).toContain('delete_note');
      expect(prompt).toContain('promote_maturity');
      expect(prompt).toContain('find_similar');
      expect(prompt).toContain('supersede');
    });
  });
});
