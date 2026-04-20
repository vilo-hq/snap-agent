import { describe, it, expect, beforeEach } from 'vitest';
import { EcommerceRAGPlugin } from '../src/EcommerceRAGPlugin';

describe('EcommerceRAGPlugin', () => {
  let plugin: EcommerceRAGPlugin;

  const defaultConfig = {
    mongoUri: 'mongodb://localhost:27017',
    dbName: 'test-db',
    collection: 'products',
    tenantId: 'test-tenant',
    openaiApiKey: 'test-openai-key',
    voyageApiKey: 'test-voyage-key',
    embeddingModel: 'voyage-multilingual-2',
    limit: 50,
  };

  beforeEach(() => {
    plugin = new EcommerceRAGPlugin(defaultConfig);
  });

  describe('initialization', () => {
    it('should create plugin with default config', () => {
      expect(plugin).toBeDefined();
      expect(plugin.name).toBe('ecommerce-rag');
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
      expect(config.mongoUri).toBe('${MONGODB_URI}');
      expect(config.openaiApiKey).toMatch(/^\$\{.+\}$/);
      expect(config.openaiApiKey).toBe('${OPENAI_API_KEY}');
      expect(config.voyageApiKey).toMatch(/^\$\{.+\}$/);
      expect(config.voyageApiKey).toBe('${VOYAGE_API_KEY}');
    });

    it('should preserve non-sensitive config values', () => {
      const config = plugin.getConfig();
      expect(config.dbName).toBe(defaultConfig.dbName);
      expect(config.collection).toBe(defaultConfig.collection);
      expect(config.tenantId).toBe(defaultConfig.tenantId);
      expect(config.embeddingModel).toBe(defaultConfig.embeddingModel);
      expect(config.limit).toBe(defaultConfig.limit);
    });

    it('config should be JSON-serializable', () => {
      const config = plugin.getConfig();
      expect(() => JSON.stringify(config)).not.toThrow();
      const serialized = JSON.stringify(config);
      expect(serialized).toBeTruthy();
    });

    it('should include all necessary fields for re-instantiation', () => {
      const config = plugin.getConfig();
      expect(config).toHaveProperty('mongoUri');
      expect(config).toHaveProperty('dbName');
      expect(config).toHaveProperty('collection');
      expect(config).toHaveProperty('tenantId');
      expect(config).toHaveProperty('openaiApiKey');
      expect(config).toHaveProperty('voyageApiKey');
      expect(config).toHaveProperty('embeddingModel');
      expect(config).toHaveProperty('attributeList');
      expect(config).toHaveProperty('enableAttributeExtraction');
      expect(config).toHaveProperty('numCandidates');
      expect(config).toHaveProperty('limit');
      expect(config).toHaveProperty('vectorIndexName');
      expect(config).toHaveProperty('rescoringWeights');
      expect(config).toHaveProperty('enableReranking');
      expect(config).toHaveProperty('rerankTopK');
      expect(config).toHaveProperty('contextProductCount');
      expect(config).toHaveProperty('language');
      expect(config).toHaveProperty('includeOutOfStock');
      expect(config).toHaveProperty('cache');
      expect(config).toHaveProperty('priority');
    });

    it('should include cache configuration', () => {
      const pluginWithCache = new EcommerceRAGPlugin({
        ...defaultConfig,
        cache: {
          embeddings: { enabled: true, ttl: 5000 },
          attributes: { enabled: true, ttl: 3000 },
        },
      });

      const config = pluginWithCache.getConfig();
      expect(config.cache).toBeDefined();
      expect(config.cache.embeddings).toHaveProperty('enabled');
      expect(config.cache.attributes).toHaveProperty('enabled');
    });
  });
});
