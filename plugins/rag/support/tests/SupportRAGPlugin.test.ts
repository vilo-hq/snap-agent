import { describe, it, expect, beforeEach } from 'vitest';
import { SupportRAGPlugin } from '../src/SupportRAGPlugin';

describe('SupportRAGPlugin', () => {
  let plugin: SupportRAGPlugin;

  const defaultConfig = {
    embeddingProviderApiKey: 'test-api-key',
    embeddingProvider: 'openai' as const,
    embeddingModel: 'text-embedding-3-small',
    limit: 5,
    minSimilarity: 0.65,
  };

  beforeEach(() => {
    plugin = new SupportRAGPlugin(defaultConfig);
  });

  describe('initialization', () => {
    it('should create plugin with default config', () => {
      expect(plugin).toBeDefined();
      expect(plugin.name).toBe('support-rag');
      expect(plugin.type).toBe('rag');
    });
  });

  describe('getConfig', () => {
    it('should return a serializable config object', () => {
      const config = plugin.getConfig();
      expect(config).toBeDefined();
      expect(typeof config).toBe('object');
    });

    it('should NOT expose sensitive values', () => {
      const config = plugin.getConfig();
      // Los valores sensibles deben ser referencias a env vars
      expect(config.embeddingProviderApiKey).toMatch(/^\$\{.+\}$/);
      expect(config.embeddingProviderApiKey).toBe('${OPENAI_API_KEY}');
    });

    it('should preserve non-sensitive config values', () => {
      const config = plugin.getConfig();
      expect(config.embeddingProvider).toBe(defaultConfig.embeddingProvider);
      expect(config.embeddingModel).toBe(defaultConfig.embeddingModel);
      expect(config.limit).toBe(defaultConfig.limit);
      expect(config.minSimilarity).toBe(defaultConfig.minSimilarity);
    });

    it('config should be JSON-serializable', () => {
      const config = plugin.getConfig();
      expect(() => JSON.stringify(config)).not.toThrow();
      const serialized = JSON.stringify(config);
      expect(serialized).toBeTruthy();
    });

    it('should include all necessary fields for re-instantiation', () => {
      const config = plugin.getConfig();
      expect(config).toHaveProperty('embeddingProviderApiKey');
      expect(config).toHaveProperty('embeddingProvider');
      expect(config).toHaveProperty('embeddingModel');
      expect(config).toHaveProperty('limit');
      expect(config).toHaveProperty('minSimilarity');
      expect(config).toHaveProperty('resolvedBoost');
      expect(config).toHaveProperty('faqBoost');
      expect(config).toHaveProperty('includeHistory');
      expect(config).toHaveProperty('maxTicketAgeDays');
    });
  });

  describe('disconnect', () => {
    it('should disconnect without errors (no-op for in-memory)', async () => {
      await expect(plugin.disconnect()).resolves.not.toThrow();
    });
  });
});
