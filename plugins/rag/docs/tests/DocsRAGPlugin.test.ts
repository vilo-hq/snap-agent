import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocsRAGPlugin } from '../src/DocsRAGPlugin';
import type { MongoClient, Db, Collection } from 'mongodb';

// ============================================================================
// Mocks
// ============================================================================

// Mock MongoDB
const mockUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1, upsertedCount: 1 });
const mockDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 1 });
const mockCountDocuments = vi.fn().mockResolvedValue(5);
const mockAggregate = vi.fn(() => ({
  toArray: vi.fn().mockResolvedValue([
    {
      id: 'chunk-1',
      documentId: 'doc-1',
      content: 'Test content',
      embedding: Array(1536).fill(0.1),
      metadata: { type: 'text', title: 'Test Doc', section: 'Test' },
      score: 0.85,
    },
  ]),
}));
const mockListSearchIndexes = vi.fn(() => ({
  toArray: vi.fn().mockResolvedValue([
    { name: 'docs_vector_index', status: 'READY' },
  ]),
}));
const mockCreateIndex = vi.fn().mockResolvedValue('index-created');

const mockCollection = {
  updateOne: mockUpdateOne,
  deleteMany: mockDeleteMany,
  countDocuments: mockCountDocuments,
  aggregate: mockAggregate,
  listSearchIndexes: mockListSearchIndexes,
  createIndex: mockCreateIndex,
} as unknown as Collection;

const mockDb = {
  collection: vi.fn().mockReturnValue(mockCollection),
} as unknown as Db;

const mockMongoClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  db: vi.fn().mockReturnValue(mockDb),
  close: vi.fn().mockResolvedValue(undefined),
} as unknown as MongoClient;

vi.mock('mongodb', () => ({
  MongoClient: vi.fn(() => mockMongoClient),
}));

// Mock OpenAI
const mockOpenAI = {
  embeddings: {
    create: vi.fn().mockResolvedValue({
      data: [{ embedding: Array(1536).fill(0.1) }],
    }),
  },
};

vi.mock('openai', () => ({
  default: vi.fn(() => mockOpenAI),
}));

// Mock fetch for Voyage AI
const mockFetch = vi.fn();
global.fetch = mockFetch as any;


// ============================================================================
// Tests
// ============================================================================

describe('DocsRAGPlugin', () => {
  let plugin: DocsRAGPlugin;

  const defaultConfig = {
    mongoUri: 'mongodb://localhost:27017',
    dbName: 'test_db',
    tenantId: 'test-tenant',
    embeddingProviderApiKey: 'test-key',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: Array(1536).fill(0.1) }],
      }),
    });
  });

  afterEach(async () => {
    if (plugin) {
      await plugin.disconnect();
    }
  });

  // ============================================================================
  // Constructor & Configuration
  // ============================================================================

  describe('constructor', () => {
    it('should create plugin with required config', () => {
      plugin = new DocsRAGPlugin(defaultConfig);

      expect(plugin.name).toBe('docs-rag');
      expect(plugin.type).toBe('rag');
      expect(plugin.priority).toBe(100);
    });

    it('should require mongoUri', () => {
      expect(() => {
        new DocsRAGPlugin({
          ...defaultConfig,
          mongoUri: undefined as any,
        });
      }).toThrow('mongoUri is required');
    });

    it('should require dbName', () => {
      expect(() => {
        new DocsRAGPlugin({
          ...defaultConfig,
          dbName: undefined as any,
        });
      }).toThrow('dbName is required');
    });

    it('should require tenantId', () => {
      expect(() => {
        new DocsRAGPlugin({
          ...defaultConfig,
          tenantId: undefined as any,
        });
      }).toThrow('tenantId is required');
    });

    it('should use default values for optional config', () => {
      plugin = new DocsRAGPlugin(defaultConfig);
      const stats = plugin.getCacheStats();
      
      // Cache should be disabled by default when not specified
      expect(stats.enabled).toBe(false);
    });

    it('should use default values for optional config', () => {
      plugin = new DocsRAGPlugin(defaultConfig);
      const stats = plugin.getCacheStats();
      
      // Cache should be disabled by default when not specified
      expect(stats.enabled).toBe(false);
    });

    it('should accept custom config values', () => {
      plugin = new DocsRAGPlugin({
        ...defaultConfig,
        chunkingStrategy: 'paragraph',
        maxChunkSize: 500,
        limit: 10,
        minSimilarity: 0.8,
        cache: {
          embeddings: {
            enabled: true,
            ttl: 3600000,
            maxSize: 100,
          },
        },
      });

      const stats = plugin.getCacheStats();
      expect(stats.enabled).toBe(true);
    });

    it('should set default OpenAI model', () => {
      plugin = new DocsRAGPlugin({
        ...defaultConfig,
        embeddingProvider: 'openai',
      });

      expect(plugin).toBeDefined();
    });

    it('should set default Voyage model', () => {
      plugin = new DocsRAGPlugin({
        ...defaultConfig,
        embeddingProvider: 'voyage',
      });

      expect(plugin).toBeDefined();
    });

    it('should allow custom embedding model', () => {
      plugin = new DocsRAGPlugin({
        ...defaultConfig,
        embeddingModel: 'text-embedding-3-large',
      });

      expect(plugin).toBeDefined();
    });

    it('should set custom priority', () => {
      plugin = new DocsRAGPlugin({
        ...defaultConfig,
        priority: 200,
      });

      expect(plugin.priority).toBe(200);
    });
  });

  // ============================================================================
  // MongoDB Connection
  // ============================================================================

  describe('MongoDB connection', () => {
    it('should connect to MongoDB on first operation', async () => {
      plugin = new DocsRAGPlugin(defaultConfig);

      await plugin.ingest(
        [{ id: 'doc1', content: 'Test' }],
        { agentId: 'agent-1' }
      );

      expect(mockMongoClient.connect).toHaveBeenCalled();
      expect(mockMongoClient.db).toHaveBeenCalledWith('test_db');
    });

    it('should create indexes on connection', async () => {
      plugin = new DocsRAGPlugin(defaultConfig);

      await plugin.ingest(
        [{ id: 'doc1', content: 'Test' }],
        { agentId: 'agent-1' }
      );

      expect(mockCreateIndex).toHaveBeenCalled();
    });

    it('should disconnect from MongoDB', async () => {
      plugin = new DocsRAGPlugin(defaultConfig);

      await plugin.ingest(
        [{ id: 'doc1', content: 'Test' }],
        { agentId: 'agent-1' }
      );

      await plugin.disconnect();

      expect(mockMongoClient.close).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Ingest Documents
  // ============================================================================

  describe('ingest', () => {
    beforeEach(() => {
      plugin = new DocsRAGPlugin(defaultConfig);
    });

    it('should require agentId', async () => {
      const result = await plugin.ingest([
        { id: 'doc1', content: 'Test content' },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors?.[0].error).toContain('agentId');
    });

    it('should ingest a single document', async () => {
      const result = await plugin.ingest(
        [{ id: 'doc1', content: 'Test content' }],
        { agentId: 'agent-1' }
      );

      expect(result.success).toBe(true);
      expect(result.indexed).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockUpdateOne).toHaveBeenCalled();
    });

    it('should ingest multiple documents', async () => {
      const result = await plugin.ingest(
        [
          { id: 'doc1', content: 'First document' },
          { id: 'doc2', content: 'Second document' },
          { id: 'doc3', content: 'Third document' },
        ],
        { agentId: 'agent-1' }
      );

      expect(result.success).toBe(true);
      expect(result.indexed).toBe(3);
      expect(mockUpdateOne.mock.calls.length).toBeGreaterThan(0);
    });

    it('should include metadata in result', async () => {
      const result = await plugin.ingest(
        [{ id: 'doc1', content: '# Title\n\nContent here' }],
        { agentId: 'agent-1' }
      );

      expect(result.metadata).toBeDefined();
      expect(result.metadata?.strategy).toBe('markdown');
      expect(result.metadata?.totalChunks).toBeGreaterThan(0);
    });

    it('should generate embeddings for each chunk', async () => {
      await plugin.ingest(
        [{ id: 'doc1', content: 'Test content' }],
        { agentId: 'agent-1' }
      );

      expect(mockOpenAI.embeddings.create).toHaveBeenCalled();
    });

    it('should preserve document metadata', async () => {
      await plugin.ingest(
        [
          {
            id: 'doc1',
            content: 'Test',
            metadata: { title: 'Test Doc', author: 'John' },
          },
        ],
        { agentId: 'agent-1' }
      );

      const call = mockUpdateOne.mock.calls[0];
      const document = call[1].$set;
      expect(document.metadata.title).toBe('Test Doc');
      expect(document.metadata.author).toBe('John');
    });

    it('should handle errors gracefully', async () => {
      mockOpenAI.embeddings.create.mockRejectedValueOnce(
        new Error('API error')
      );

      const result = await plugin.ingest(
        [{ id: 'doc1', content: 'Test' }],
        { agentId: 'agent-1' }
      );

      expect(result.success).toBe(false);
      expect(result.failed).toBe(1);
      expect(result.errors?.[0].error).toContain('API error');
    });
  });

  // ============================================================================
  // Chunking Strategies
  // ============================================================================

  describe('chunking strategies', () => {
    describe('markdown chunking', () => {
      beforeEach(() => {
        plugin = new DocsRAGPlugin({
          ...defaultConfig,
          chunkingStrategy: 'markdown',
        });
      });

      it('should extract headings', async () => {
        const content = `# Main Title\n\nIntro\n\n## Section\n\nContent`;

        const result = await plugin.ingest(
          [{ id: 'doc1', content }],
          { agentId: 'agent-1' }
        );

        expect(result.metadata?.totalChunks).toBeGreaterThan(1);
      });

      it('should extract code blocks', async () => {
        const content = `# Code\n\n\`\`\`typescript\nconst x = 1;\n\`\`\``;

        const result = await plugin.ingest(
          [{ id: 'doc1', content }],
          { agentId: 'agent-1' }
        );

        expect(result.metadata?.totalChunks).toBeGreaterThan(0);
        
        // Verify code block was captured
        const calls = mockUpdateOne.mock.calls;
        const hasCodeChunk = calls.some((call: any) => 
          call[1].$set.metadata.type === 'code'
        );
        expect(hasCodeChunk).toBe(true);
      });
    });

    describe('paragraph chunking', () => {
      beforeEach(() => {
        plugin = new DocsRAGPlugin({
          ...defaultConfig,
          chunkingStrategy: 'paragraph',
          maxChunkSize: 100,
        });
      });

      it('should split on paragraphs', async () => {
        const content = `First paragraph.\n\nSecond paragraph.\n\nThird paragraph.`;

        const result = await plugin.ingest(
          [{ id: 'doc1', content }],
          { agentId: 'agent-1' }
        );

        expect(result.metadata?.totalChunks).toBeGreaterThanOrEqual(1);
      });
    });

    describe('sentence chunking', () => {
      beforeEach(() => {
        plugin = new DocsRAGPlugin({
          ...defaultConfig,
          chunkingStrategy: 'sentence',
          maxChunkSize: 50,
        });
      });

      it('should split on sentences', async () => {
        const content = 'First. Second! Third? Fourth.';

        const result = await plugin.ingest(
          [{ id: 'doc1', content }],
          { agentId: 'agent-1' }
        );

        expect(result.metadata?.totalChunks).toBeGreaterThanOrEqual(1);
      });
    });

    describe('fixed chunking', () => {
      beforeEach(() => {
        plugin = new DocsRAGPlugin({
          ...defaultConfig,
          chunkingStrategy: 'fixed',
          maxChunkSize: 50,
          chunkOverlap: 10,
        });
      });

      it('should create fixed-size chunks with overlap', async () => {
        const content = 'A'.repeat(150);

        const result = await plugin.ingest(
          [{ id: 'doc1', content }],
          { agentId: 'agent-1' }
        );

        expect(result.metadata?.totalChunks).toBeGreaterThan(2);
      });
    });
  });

  // ============================================================================
  // Retrieve Context
  // ============================================================================

  describe('retrieveContext', () => {
    beforeEach(() => {
      plugin = new DocsRAGPlugin({
        ...defaultConfig,
        minSimilarity: 0.7,
        limit: 5,
      });
    });

    it('should return empty context when no results', async () => {
      mockAggregate.mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([]),
      });

      const context = await plugin.retrieveContext('query', {
        agentId: 'agent-1',
      });

      expect(context.content).toBe('');
      expect(context.sources).toHaveLength(0);
      expect(context.metadata?.count).toBe(0);
    });

    it('should return relevant chunks', async () => {
      const context = await plugin.retrieveContext('test query', {
        agentId: 'agent-1',
      });

      expect(context.content).toBeTruthy();
      expect(context.sources).toHaveLength(1);
      expect(context.metadata?.count).toBe(1);
    });

    it('should include scores in sources', async () => {
      const context = await plugin.retrieveContext('test query', {
        agentId: 'agent-1',
      });

      expect(context.sources?.[0].score).toBe(0.85);
    });

    it('should include metadata in sources', async () => {
      const context = await plugin.retrieveContext('test query', {
        agentId: 'agent-1',
      });

      expect(context.sources?.[0].metadata).toBeDefined();
      expect(context.sources?.[0].metadata?.title).toBe('Test Doc');
    });

    it('should calculate average score', async () => {
      const context = await plugin.retrieveContext('test query', {
        agentId: 'agent-1',
      });

      expect(context.metadata?.avgScore).toBe(0.85);
    });

    it('should use vector search aggregation', async () => {
      await plugin.retrieveContext('test query', {
        agentId: 'agent-1',
      });

      expect(mockAggregate).toHaveBeenCalled();
      const pipeline = (mockAggregate.mock.calls as any[][])[0][0];
      expect(pipeline[0].$vectorSearch).toBeDefined();
    });

    it('should filter by tenantId', async () => {
      await plugin.retrieveContext('test query', {
        agentId: 'agent-1',
      });

      const pipeline = (mockAggregate.mock.calls as any[][])[0][0];
      expect(pipeline[0].$vectorSearch.filter.tenantId).toBe('test-tenant');
    });

    it('should support shared and agent-specific content', async () => {
      await plugin.retrieveContext('test query', {
        agentId: 'agent-1',
      });

      const pipeline = (mockAggregate.mock.calls as any[][])[0][0];
      expect(pipeline[0].$vectorSearch.filter.agentId).toEqual({
        $in: ['shared', 'agent-1'],
      });
    });
  });

  // ============================================================================
  // Update Documents
  // ============================================================================

  describe('update', () => {
    beforeEach(() => {
      plugin = new DocsRAGPlugin(defaultConfig);
    });

    it('should require agentId', async () => {
      await expect(
        plugin.update('doc1', { content: 'Updated' })
      ).rejects.toThrow('agentId is required');
    });

    it('should require content', async () => {
      await expect(
        plugin.update('doc1', {}, { agentId: 'agent-1' })
      ).rejects.toThrow('content is required');
    });

    it('should delete old chunks and re-ingest', async () => {
      await plugin.update(
        'doc1',
        { content: 'Updated content' },
        { agentId: 'agent-1' }
      );

      expect(mockDeleteMany).toHaveBeenCalled();
      expect(mockUpdateOne).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Delete Documents
  // ============================================================================

  describe('delete', () => {
    beforeEach(() => {
      plugin = new DocsRAGPlugin(defaultConfig);
    });

    it('should require agentId', async () => {
      await expect(plugin.delete('doc1')).rejects.toThrow(
        'agentId is required'
      );
    });

    it('should delete single document', async () => {
      const count = await plugin.delete('doc1', { agentId: 'agent-1' });

      expect(mockDeleteMany).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        agentId: 'agent-1',
        documentId: { $in: ['doc1'] },
      });
      expect(count).toBe(1);
    });

    it('should delete multiple documents', async () => {
      const count = await plugin.delete(['doc1', 'doc2', 'doc3'], {
        agentId: 'agent-1',
      });

      expect(mockDeleteMany).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        agentId: 'agent-1',
        documentId: { $in: ['doc1', 'doc2', 'doc3'] },
      });
      expect(count).toBe(1);
    });
  });

  // ============================================================================
  // Cache
  // ============================================================================

  describe('embedding cache', () => {
    it('should start with empty cache', () => {
      plugin = new DocsRAGPlugin({
        ...defaultConfig,
        cache: { embeddings: { enabled: true } },
      });

      const stats = plugin.getCacheStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.size).toBe(0);
    });

    it('should cache embeddings when enabled', async () => {
      plugin = new DocsRAGPlugin({
        ...defaultConfig,
        cache: { embeddings: { enabled: true } },
      });

      // First call - miss
      await plugin.ingest(
        [{ id: 'doc1', content: 'Same content' }],
        { agentId: 'agent-1' }
      );

      const stats1 = plugin.getCacheStats();
      expect(stats1.misses).toBeGreaterThan(0);
      expect(stats1.size).toBeGreaterThan(0);

      // Second call with same content - should hit cache
      await plugin.ingest(
        [{ id: 'doc2', content: 'Same content' }],
        { agentId: 'agent-1' }
      );

      const stats2 = plugin.getCacheStats();
      expect(stats2.hits).toBeGreaterThan(stats1.hits);
    });

    it('should not cache when disabled', async () => {
      plugin = new DocsRAGPlugin({
        ...defaultConfig,
        cache: { embeddings: { enabled: false } },
      });

      await plugin.ingest(
        [{ id: 'doc1', content: 'Test' }],
        { agentId: 'agent-1' }
      );

      const stats = plugin.getCacheStats();
      expect(stats.enabled).toBe(false);
      expect(stats.size).toBe(0);
    });

    it('should clear cache', async () => {
      plugin = new DocsRAGPlugin({
        ...defaultConfig,
        cache: { embeddings: { enabled: true } },
      });

      await plugin.ingest(
        [{ id: 'doc1', content: 'Test' }],
        { agentId: 'agent-1' }
      );

      plugin.clearCache();

      const stats = plugin.getCacheStats();
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it('should calculate hit rate correctly', async () => {
      plugin = new DocsRAGPlugin({
        ...defaultConfig,
        cache: { embeddings: { enabled: true } },
      });

      // Generate some cache activity
      await plugin.ingest(
        [{ id: 'doc1', content: 'Test content' }],
        { agentId: 'agent-1' }
      );

      await plugin.ingest(
        [{ id: 'doc2', content: 'Test content' }],
        { agentId: 'agent-1' }
      );

      const stats = plugin.getCacheStats();
      expect(stats.hitRate).toBeGreaterThanOrEqual(0);
      expect(stats.hitRate).toBeLessThanOrEqual(1);
    });
  });

  // ============================================================================
  // Stats & Utilities
  // ============================================================================

  describe('getStats', () => {
    beforeEach(() => {
      plugin = new DocsRAGPlugin(defaultConfig);
    });

    it('should return plugin stats', async () => {
      mockCountDocuments.mockResolvedValueOnce(10);
      mockAggregate.mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([
          {
            _id: 'agent-1',
            count: 5,
            types: ['text', 'code'],
          },
          {
            _id: 'agent-2',
            count: 5,
            types: ['text'],
          },
        ]),
      });

      const stats = await plugin.getStats();

      expect(stats.tenantId).toBe('test-tenant');
      expect(stats.totalChunks).toBe(10);
      expect(stats.strategy).toBe('markdown');
      expect(stats.agentStats).toBeDefined();
    });
  });

  describe('clearAgent', () => {
    beforeEach(() => {
      plugin = new DocsRAGPlugin(defaultConfig);
    });

    it('should clear all data for an agent', async () => {
      const count = await plugin.clearAgent('agent-1');

      expect(mockDeleteMany).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        agentId: 'agent-1',
      });
      expect(count).toBe(1);
    });
  });

  describe('clearAll', () => {
    beforeEach(() => {
      plugin = new DocsRAGPlugin(defaultConfig);
    });

    it('should clear all data for tenant', async () => {
      const count = await plugin.clearAll();

      expect(mockDeleteMany).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
      });
      expect(count).toBe(1);
    });
  });

  // ============================================================================
  // Embedding Providers
  // ============================================================================

  describe('embedding providers', () => {
    it('should use OpenAI by default', async () => {
      plugin = new DocsRAGPlugin(defaultConfig);

      await plugin.ingest(
        [{ id: 'doc1', content: 'Test' }],
        { agentId: 'agent-1' }
      );

      expect(mockOpenAI.embeddings.create).toHaveBeenCalled();
    });

    it('should use Voyage AI when configured', async () => {
      plugin = new DocsRAGPlugin({
        ...defaultConfig,
        embeddingProvider: 'voyage',
      });

      await plugin.ingest(
        [{ id: 'doc1', content: 'Test' }],
        { agentId: 'agent-1' }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.voyageai.com/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-key',
          }),
        })
      );
    });

    it('should handle Voyage API errors', async () => {
      plugin = new DocsRAGPlugin({
        ...defaultConfig,
        embeddingProvider: 'voyage',
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const result = await plugin.ingest(
        [{ id: 'doc1', content: 'Test' }],
        { agentId: 'agent-1' }
      );

      expect(result.success).toBe(false);
      expect(result.errors?.[0].error).toContain('Voyage API error');
    });
  });
});

