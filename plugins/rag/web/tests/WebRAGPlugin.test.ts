import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebRAGPlugin } from '../src/WebRAGPlugin';

// Mock MongoDB (findOne / find for crawl ledger)
const mongoLedger = vi.hoisted(() => {
  const toArrayFind = vi.fn().mockResolvedValue([]);
  const mockFindOne = vi.fn().mockResolvedValue(null);
  const mockUpdateOne = vi.fn().mockResolvedValue({ upsertedCount: 1 });
  const mockUpdateMany = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const mockBulkWrite = vi.fn().mockResolvedValue({ upsertedCount: 1, modifiedCount: 0 });
  const mockCreateIndex = vi.fn().mockResolvedValue('idx');
  const mockDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 1 });
  const mockCollection = {
    aggregate: vi.fn().mockReturnValue({
      toArray: vi.fn().mockResolvedValue([]),
    }),
    updateOne: mockUpdateOne,
    updateMany: mockUpdateMany,
    bulkWrite: mockBulkWrite,
    createIndex: mockCreateIndex,
    deleteMany: mockDeleteMany,
    findOne: mockFindOne,
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: toArrayFind,
          }),
        }),
      }),
    }),
  };
  const mockDb = {
    collection: vi.fn().mockReturnValue(mockCollection),
  };
  const mockClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    db: vi.fn().mockReturnValue(mockDb),
  };
  return {
    MongoClient: vi.fn().mockImplementation(() => mockClient),
    mockFindOne,
    mockUpdateOne,
    mockUpdateMany,
    mockBulkWrite,
    mockCreateIndex,
    mockDeleteMany,
    mockClient,
    toArrayFind,
  };
});

vi.mock('mongodb', () => ({
  MongoClient: mongoLedger.MongoClient,
}));

// Mock OpenAI — batch-aware: returns one item per input (string or string[]),
// each carrying its `index` and an embedding whose first slot encodes the input
// text length so tests can verify ordering/alignment.
const openaiMock = vi.hoisted(() => {
  const create = vi.fn(async (params: { input: string | string[] }) => {
    const inputs = Array.isArray(params.input) ? params.input : [params.input];
    return {
      data: inputs.map((text, index) => {
        const embedding = new Array(1536).fill(0.1);
        embedding[0] = text.length;
        return { index, embedding };
      }),
    };
  });
  return { create };
});

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      embeddings: { create: openaiMock.create },
    })),
  };
});

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('WebRAGPlugin', () => {
  let plugin: WebRAGPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    // Some tests install a client-specific implementation; restore the fixture client so it does
    // not leak into subsequent tests, because clearAllMocks() preserves mock implementations.
    mongoLedger.MongoClient.mockImplementation(() => mongoLedger.mockClient);
    mongoLedger.mockFindOne.mockResolvedValue(null);
    mongoLedger.toArrayFind.mockResolvedValue([]);
    plugin = new WebRAGPlugin({
      mongoUri: 'mongodb://localhost:27017',
      dbName: 'test_db',
      openaiApiKey: 'test-key',
      tenantId: 'test-tenant',
    });
  });

  afterEach(async () => {
    await plugin.disconnect();
  });

  describe('constructor', () => {
    it('should set default values', () => {
      expect(plugin.name).toBe('web-rag');
      expect(plugin.type).toBe('rag');
      expect(plugin.priority).toBe(100);
    });

    it('should accept custom priority', () => {
      const customPlugin = new WebRAGPlugin({
        mongoUri: 'mongodb://localhost:27017',
        dbName: 'test_db',
        openaiApiKey: 'test-key',
        tenantId: 'test-tenant',
        priority: 200,
      });
      expect(customPlugin.priority).toBe(200);
    });
  });

  describe('ingest', () => {
    it('should ingest documents successfully', async () => {
      const documents = [
        {
          id: 'doc-1',
          content: 'Test content for document 1',
          metadata: { type: 'blog', title: 'Test Blog' },
        },
        {
          id: 'doc-2',
          content: 'Test content for document 2',
          metadata: { type: 'page', title: 'Test Page' },
        },
      ];

      const result = await plugin.ingest(documents);

      expect(result.success).toBe(true);
      expect(result.indexed).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('should ingest with agentId for agent-specific content', async () => {
      const documents = [
        {
          id: 'doc-1',
          content: 'Agent-specific content',
          metadata: { type: 'project' },
        },
      ];

      const result = await plugin.ingest(documents, { agentId: 'agent-123' });

      expect(result.success).toBe(true);
      expect(result.indexed).toBe(1);
    });

    it('should set default type if not provided', async () => {
      const documents = [
        {
          id: 'doc-1',
          content: 'Content without type',
          metadata: {},
        },
      ];

      const result = await plugin.ingest(documents);

      expect(result.success).toBe(true);
    });

    it('should handle batch ingestion', async () => {
      const documents = Array.from({ length: 25 }, (_, i) => ({
        id: `doc-${i}`,
        content: `Content ${i}`,
        metadata: { type: 'blog' },
      }));

      const result = await plugin.ingest(documents, { batchSize: 10 });

      expect(result.success).toBe(true);
      expect(result.indexed).toBe(25);
    });
  });

  describe('embedding batching', () => {
    it('sends arrays of texts and batches requests (not one per chunk)', async () => {
      const documents = Array.from({ length: 250 }, (_, i) => ({
        id: `doc-${i}`,
        content: `Content number ${i}`,
        metadata: { type: 'blog' },
      }));

      const result = await plugin.ingest(documents);

      expect(result.success).toBe(true);
      expect(result.indexed).toBe(250);

      // 250 chunks / batchSize 100 => 3 requests, each with an array input.
      expect(openaiMock.create).toHaveBeenCalledTimes(3);
      for (const call of openaiMock.create.mock.calls) {
        expect(Array.isArray(call[0].input)).toBe(true);
      }
      const sizes = openaiMock.create.mock.calls.map((c) => (c[0].input as string[]).length);
      expect(sizes).toEqual([100, 100, 50]);

      // Persistence uses bulkWrite, not one updateOne per chunk.
      expect(mongoLedger.mockBulkWrite).toHaveBeenCalled();
      expect(mongoLedger.mockUpdateOne).not.toHaveBeenCalled();
    });

    it('aligns each embedding with its own chunk', async () => {
      const documents = Array.from({ length: 5 }, (_, i) => ({
        id: `doc-${i}`,
        content: 'x'.repeat(10 + i), // distinct lengths => distinct embedding[0]
        metadata: { type: 'blog' },
      }));

      await plugin.ingest(documents);

      const ops = mongoLedger.mockBulkWrite.mock.calls.flatMap((c) => c[0] as any[]);
      expect(ops).toHaveLength(5);
      for (const op of ops) {
        const stored = op.updateOne.update.$set;
        // mock encodes input length in embedding[0]
        expect(stored.embedding[0]).toBe(stored.content.length);
      }
    });

    it('reuses cached embeddings on re-ingest (no new API calls)', async () => {
      const cachedPlugin = new WebRAGPlugin({
        mongoUri: 'mongodb://localhost:27017',
        dbName: 'test_db',
        openaiApiKey: 'test-key',
        tenantId: 'test-tenant',
        cache: { embeddings: { enabled: true } },
      });

      const documents = [
        { id: 'doc-1', content: 'Cached content', metadata: { type: 'blog' } },
      ];

      await cachedPlugin.ingest(documents);
      const callsAfterFirst = openaiMock.create.mock.calls.length;

      await cachedPlugin.ingest(documents);
      expect(openaiMock.create.mock.calls.length).toBe(callsAfterFirst);

      await cachedPlugin.disconnect();
    });

    it('emits crawl progress incrementally across macro-batches (live progress)', async () => {
      // macro-batch = embeddingBatchSize * embeddingConcurrency = 1 => one
      // crawl-progress emit per chunk, so the counter climbs gradually.
      const incremental = new WebRAGPlugin({
        mongoUri: 'mongodb://localhost:27017',
        dbName: 'test_db',
        openaiApiKey: 'test-key',
        tenantId: 'test-tenant',
        embeddingBatchSize: 1,
        embeddingConcurrency: 1,
      });

      const seen: number[] = [];
      const documents = Array.from({ length: 5 }, (_, i) => ({
        id: `doc-${i}`,
        content: `Content ${i}`,
        metadata: { type: 'blog' },
      }));

      await incremental.ingest(documents, {
        metadata: {
          onCrawlProgress: (u: { phase: string; chunksProcessed: number }) => {
            if (u.phase === 'indexing') seen.push(u.chunksProcessed);
          },
        },
      } as any);

      // Initial emit at 0, then one per macro-batch climbing to the total.
      expect(seen[0]).toBe(0);
      expect(seen.filter((n) => n > 0)).toEqual([1, 2, 3, 4, 5]);

      await incremental.disconnect();
    });

    it('isolates per-document failures when a bulkWrite batch fails', async () => {
      mongoLedger.mockBulkWrite.mockRejectedValueOnce(new Error('write failed'));

      const documents = [
        { id: 'doc-1', content: 'A', metadata: { type: 'blog' } },
        { id: 'doc-2', content: 'B', metadata: { type: 'blog' } },
      ];

      const result = await plugin.ingest(documents);

      expect(result.success).toBe(false);
      expect(result.failed).toBe(2);
      expect(result.indexed).toBe(0);
      expect(result.errors?.[0].error).toContain('write failed');
    });
  });

  describe('update', () => {
    it('should update document content', async () => {
      await expect(
        plugin.update('doc-1', { content: 'Updated content' })
      ).resolves.not.toThrow();
    });

    it('should update document metadata', async () => {
      await expect(
        plugin.update('doc-1', { metadata: { title: 'New Title' } })
      ).resolves.not.toThrow();
    });
  });

  describe('delete', () => {
    it('should delete single document', async () => {
      const count = await plugin.delete('doc-1');
      expect(count).toBe(1);
    });

    it('should delete multiple documents', async () => {
      const count = await plugin.delete(['doc-1', 'doc-2']);
      expect(count).toBe(1); // Mocked to return 1
    });
  });

  describe('bulk operations', () => {
    it('should handle mixed bulk operations', async () => {
      const operations = [
        {
          type: 'insert' as const,
          id: 'new-doc',
          document: {
            id: 'new-doc',
            content: 'New content',
            metadata: { type: 'blog' },
          },
        },
        {
          type: 'update' as const,
          id: 'existing-doc',
          document: { content: 'Updated' },
        },
        {
          type: 'delete' as const,
          id: 'old-doc',
        },
      ];

      const result = await plugin.bulk(operations);

      expect(result.inserted).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.deleted).toBe(1);
    });

    it('should emit bulk and crawl progress callbacks on insert', async () => {
      const bulkUpdates: Array<{ phase: string; opsDone: number; opsTotal: number }> = [];
      const crawlUpdates: Array<{ phase: string; chunksTotal?: number }> = [];

      const operations = [
        {
          type: 'insert' as const,
          id: 'u1',
          document: {
            id: 'u1',
            content: 'https://example.com/a',
            metadata: { url: 'https://example.com/a', type: 'page' },
          },
        },
        {
          type: 'insert' as const,
          id: 'u2',
          document: {
            id: 'u2',
            content: 'https://example.com/b',
            metadata: { url: 'https://example.com/b', type: 'page' },
          },
        },
        {
          type: 'insert' as const,
          id: 'u3',
          document: {
            id: 'u3',
            content: 'https://example.com/c',
            metadata: { url: 'https://example.com/c', type: 'page' },
          },
        },
      ];

      await plugin.bulk(operations, {
        agentId: 'agent-1',
        metadata: {
          onBulkProgress: (u) => {
            bulkUpdates.push({
              phase: u.phase,
              opsDone: u.opsDone,
              opsTotal: u.opsTotal,
            });
          },
          onCrawlProgress: (u) => {
            crawlUpdates.push({ phase: u.phase, chunksTotal: u.chunksTotal });
          },
        },
      });

      expect(bulkUpdates.length).toBeGreaterThanOrEqual(4);
      expect(bulkUpdates[0]).toEqual({ phase: 'processing', opsDone: 0, opsTotal: 3 });
      expect(bulkUpdates[bulkUpdates.length - 1]?.opsDone).toBe(3);
      expect(crawlUpdates.some((u) => u.phase === 'indexing' && (u.chunksTotal ?? 0) > 0)).toBe(
        true,
      );
    });

    it('should crawl URL listing inserts instead of indexing literal input text', async () => {
      const crawlSpy = vi
        .spyOn(plugin, 'ingestSinglePageFromUrl')
        .mockResolvedValue({
          success: true,
          indexed: 1,
          failed: 0,
          urlsCrawled: 1,
          urlsSkipped: 0,
          urlsFailed: 0,
          crawledAt: new Date(),
        });

      const ingestSpy = vi.spyOn(plugin, 'ingest');

      await plugin.bulk([
        {
          type: 'insert',
          id: 'page-1',
          document: {
            id: 'page-1',
            content: 'My label\n\nhttps://example.com/page',
            metadata: {
              type: 'url',
              url: 'https://example.com/page',
              title: 'My label',
            },
          },
        },
      ]);

      expect(crawlSpy).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://example.com/page' }),
        expect.anything(),
      );
      expect(ingestSpy).not.toHaveBeenCalled();

      crawlSpy.mockRestore();
      ingestSpy.mockRestore();
    });
  });

  describe('ingestFromUrl', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('should ingest JSON from URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: '1', content: 'Content 1', type: 'blog' },
          { id: '2', content: 'Content 2', type: 'page' },
        ],
      });

      const result = await plugin.ingestFromUrl({
        url: 'https://api.example.com/content',
        type: 'json',
        transform: {
          fieldMapping: {
            id: 'id',
            content: 'content',
            type: 'type',
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.documentsFetched).toBe(2);
      expect(result.sourceUrl).toBe('https://api.example.com/content');
    });

    it('should ingest JSON:API format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'uuid-1',
              type: 'node--project',
              attributes: {
                title: 'Project 1',
                body: { processed: 'Project content' },
              },
            },
          ],
        }),
      });

      const result = await plugin.ingestFromUrl({
        url: 'https://drupal.example.com/jsonapi/node/project',
        type: 'json',
        transform: {
          documentPath: 'data',
          fieldMapping: {
            id: 'id',
            content: 'attributes.body.processed',
            type: () => 'project',
            title: 'attributes.title',
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.documentsFetched).toBe(1);
    });

    it('should ingest CSV from URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => 'id,content,type\n1,Content 1,blog\n2,Content 2,page',
      });

      const result = await plugin.ingestFromUrl({
        url: 'https://example.com/content.csv',
        type: 'csv',
        transform: {
          fieldMapping: {
            id: 'id',
            content: 'content',
            type: 'type',
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.documentsFetched).toBe(2);
    });

    it('should handle authentication', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      await plugin.ingestFromUrl({
        url: 'https://api.example.com/private',
        type: 'json',
        auth: {
          type: 'bearer',
          token: 'secret-token',
        },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/private',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer secret-token',
          }),
        })
      );
    });

    it('should handle basic auth', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      await plugin.ingestFromUrl({
        url: 'https://api.example.com/private',
        type: 'json',
        auth: {
          type: 'basic',
          username: 'user',
          password: 'pass',
        },
      });

      const expectedAuth = Buffer.from('user:pass').toString('base64');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/private',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${expectedAuth}`,
          }),
        })
      );
    });

    it('should handle API key auth', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      await plugin.ingestFromUrl({
        url: 'https://api.example.com/private',
        type: 'json',
        auth: {
          type: 'api-key',
          header: 'X-API-Key',
          key: 'my-api-key',
        },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/private',
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-API-Key': 'my-api-key',
          }),
        })
      );
    });

    it('should handle fetch errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const result = await plugin.ingestFromUrl({
        url: 'https://api.example.com/missing',
        type: 'json',
      });

      expect(result.success).toBe(false);
      expect(result.errors?.[0].error).toContain('HTTP error: 404');
    });

    it('should add source metadata to documents', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: '1', content: 'Test' }],
      });

      const result = await plugin.ingestFromUrl({
        url: 'https://api.example.com/content',
        type: 'json',
        metadata: { source: 'external-api' },
      });

      expect(result.success).toBe(true);
    });
  });

  describe('ingestFromDrupal', () => {
    it('should ingest from multiple Drupal content types', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [
              {
                id: 'project-1',
                attributes: {
                  title: 'Project 1',
                  body: { processed: 'Project content' },
                  path: { alias: '/projects/project-1' },
                },
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [
              {
                id: 'news-1',
                attributes: {
                  title: 'News 1',
                  body: { processed: 'News content' },
                  path: { alias: '/news/news-1' },
                },
              },
            ],
          }),
        });

      const results = await plugin.ingestFromDrupal({
        baseUrl: 'https://example-cms.com',
        contentTypes: ['project', 'news'],
      });

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    it('should use custom field mappings per content type', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'team-1',
              attributes: {
                title: 'Jane Smith',
                field_bio: { processed: 'Bio content' },
                field_role: 'Principal',
                path: { alias: '/people/jane-smith' },
              },
            },
          ],
        }),
      });

      const results = await plugin.ingestFromDrupal({
        baseUrl: 'https://example-cms.com',
        contentTypes: ['team_member'],
        mappings: {
          team_member: {
            content: 'attributes.field_bio.processed',
            fields: {
              role: 'attributes.field_role',
            },
          },
        },
      });

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
    });
  });

  describe('parseDrupalType', () => {
    it('should parse Drupal node types', () => {
      expect(WebRAGPlugin.parseDrupalType('node--project')).toBe('project');
      expect(WebRAGPlugin.parseDrupalType('node--team_member')).toBe('team_member');
      expect(WebRAGPlugin.parseDrupalType('project')).toBe('project');
    });
  });

  describe('cache', () => {
    it('should return cache stats', () => {
      const stats = plugin.getCacheStats();
      expect(stats).toHaveProperty('hits');
      expect(stats).toHaveProperty('misses');
      expect(stats).toHaveProperty('hitRate');
    });

    it('should clear cache', () => {
      plugin.clearCache();
      const stats = plugin.getCacheStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe('getConfig', () => {
    it('should return serializable config', () => {
      const config = plugin.getConfig();
      expect(config.name).toBe('web-rag');
      expect(config.tenantId).toBe('test-tenant');
      expect(config.mongoUri).toBe('${MONGODB_URI}');
      expect(config.openaiApiKey).toBe('${OPENAI_API_KEY}');
    });
  });

  describe('type and recency boosts', () => {
    it('should accept type boosts configuration', () => {
      const pluginWithBoosts = new WebRAGPlugin({
        mongoUri: 'mongodb://localhost:27017',
        dbName: 'test_db',
        openaiApiKey: 'test-key',
        tenantId: 'test-tenant',
        typeBoosts: {
          project: 1.2,
          news: 0.8,
        },
      });

      const config = pluginWithBoosts.getConfig();
      expect(config.typeBoosts).toEqual({ project: 1.2, news: 0.8 });
    });

    it('should accept recency boost configuration', () => {
      const pluginWithRecency = new WebRAGPlugin({
        mongoUri: 'mongodb://localhost:27017',
        dbName: 'test_db',
        openaiApiKey: 'test-key',
        tenantId: 'test-tenant',
        recencyBoost: {
          enabled: true,
          field: 'publishedAt',
          decayDays: 90,
          maxBoost: 1.3,
        },
      });

      const config = pluginWithRecency.getConfig();
      expect(config.recencyBoost).toEqual({
        enabled: true,
        field: 'publishedAt',
        decayDays: 90,
        maxBoost: 1.3,
      });
    });
  });

  describe('flexible metadata', () => {
    it('should store and return any metadata fields', async () => {
      const documents = [
        {
          id: 'architecture-project-1',
          content: 'The Sahara West Library is a 65,000 SF public library...',
          metadata: {
            type: 'project',
            title: 'Sahara West Library',
            url: '/projects/sahara-west-library',
            // Custom architecture firm fields
            location: 'Las Vegas, NV',
            sector: 'Cultural',
            services: ['Architecture', 'Interior Design'],
            completionYear: 2018,
            featured: true,
            awards: ['AIA Honor Award'],
          },
        },
      ];

      const result = await plugin.ingest(documents);

      expect(result.success).toBe(true);
      expect(result.indexed).toBe(1);
    });
  });

  describe('ingestFromWordPress', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('should ingest posts and pages from WordPress', async () => {
      // First call: posts
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 1,
            title: { rendered: 'Hello World' },
            content: { rendered: '<p>Welcome to WordPress.</p>' },
            excerpt: { rendered: 'Welcome...' },
            link: 'https://myblog.com/hello-world',
            slug: 'hello-world',
            date: '2024-01-15T10:00:00',
            modified: '2024-01-16T12:00:00',
            _embedded: {
              author: [{ name: 'Admin' }],
            },
          },
        ],
      });

      // Second call: no more posts
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      // Third call: pages
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 2,
            title: { rendered: 'About Us' },
            content: { rendered: '<p>About our company.</p>' },
            link: 'https://myblog.com/about',
            slug: 'about',
          },
        ],
      });

      // Fourth call: no more pages
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const results = await plugin.ingestFromWordPress({
        baseUrl: 'https://myblog.com',
        postTypes: ['posts', 'pages'],
        perPage: 100,
      });

      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/wp-json/wp/v2/posts'),
        expect.any(Object)
      );
    });

    it('should handle pagination', async () => {
      // Page 1: full page of results
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => Array(10).fill(null).map((_, i) => ({
          id: i,
          title: { rendered: `Post ${i}` },
          content: { rendered: `Content ${i}` },
          link: `https://myblog.com/post-${i}`,
        })),
      });

      // Page 2: partial results
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 10,
            title: { rendered: 'Post 10' },
            content: { rendered: 'Content 10' },
            link: 'https://myblog.com/post-10',
          },
        ],
      });

      const results = await plugin.ingestFromWordPress({
        baseUrl: 'https://myblog.com',
        postTypes: ['posts'],
        perPage: 10,
      });

      expect(results.length).toBe(2);
    });
  });

  describe('ingestFromSanity', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('should ingest from Sanity using GROQ queries', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: [
            {
              _id: 'post-1',
              title: 'My First Post',
              body: 'This is the content of my first post.',
              slug: { current: 'my-first-post' },
              publishedAt: '2024-01-15',
              _updatedAt: '2024-01-16',
            },
            {
              _id: 'post-2',
              title: 'Second Post',
              body: 'Content of the second post.',
              slug: { current: 'second-post' },
            },
          ],
        }),
      });

      const results = await plugin.ingestFromSanity({
        projectId: 'abc123',
        dataset: 'production',
        queries: {
          post: {
            query: '*[_type == "post"]',
            content: 'body',
          },
        },
      });

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].documentsFetched).toBe(2);
    });

    it('should use CDN by default', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: [] }),
      });

      await plugin.ingestFromSanity({
        projectId: 'abc123',
        dataset: 'production',
        queries: {
          post: { query: '*[_type == "post"]', content: 'body' },
        },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('apicdn.sanity.io'),
        expect.any(Object)
      );
    });

    it('should use auth token when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: [] }),
      });

      await plugin.ingestFromSanity({
        projectId: 'abc123',
        dataset: 'production',
        token: 'secret-token',
        queries: {
          post: { query: '*[_type == "post"]', content: 'body' },
        },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer secret-token',
          }),
        })
      );
    });
  });

  describe('sanityBlocksToText', () => {
    it('should convert Portable Text blocks to plain text', () => {
      const blocks = [
        {
          _type: 'block',
          children: [
            { text: 'Hello ' },
            { text: 'World' },
          ],
        },
        {
          _type: 'block',
          children: [
            { text: 'Second paragraph.' },
          ],
        },
      ];

      const text = WebRAGPlugin.sanityBlocksToText(blocks);
      expect(text).toBe('Hello World\n\nSecond paragraph.');
    });

    it('should handle empty or invalid input', () => {
      expect(WebRAGPlugin.sanityBlocksToText([])).toBe('');
      expect(WebRAGPlugin.sanityBlocksToText(null as any)).toBe('');
    });
  });

  describe('ingestFromStrapi', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('should ingest from Strapi v4', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 1,
              attributes: {
                title: 'First Article',
                content: 'Article content here.',
                slug: 'first-article',
                publishedAt: '2024-01-15T10:00:00Z',
                updatedAt: '2024-01-16T12:00:00Z',
              },
            },
            {
              id: 2,
              attributes: {
                title: 'Second Article',
                content: 'More content.',
                slug: 'second-article',
              },
            },
          ],
          meta: {
            pagination: { page: 1, pageSize: 100, total: 2 },
          },
        }),
      });

      const results = await plugin.ingestFromStrapi({
        baseUrl: 'https://my-strapi.com',
        contentTypes: ['articles'],
      });

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].documentsFetched).toBe(2);
    });

    it('should use API token authentication', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await plugin.ingestFromStrapi({
        baseUrl: 'https://my-strapi.com',
        apiToken: 'my-api-token',
        contentTypes: ['articles'],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-api-token',
          }),
        })
      );
    });

    it('should handle pagination', async () => {
      // Page 1: full page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: Array(100).fill(null).map((_, i) => ({
            id: i,
            attributes: { title: `Article ${i}`, content: `Content ${i}` },
          })),
        }),
      });

      // Page 2: partial page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 100, attributes: { title: 'Article 100', content: 'Content 100' } },
          ],
        }),
      });

      const results = await plugin.ingestFromStrapi({
        baseUrl: 'https://my-strapi.com',
        contentTypes: ['articles'],
        pageSize: 100,
      });

      expect(results.length).toBe(2);
    });

    it('should support Strapi v3 format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 1,
              title: 'V3 Article',
              content: 'V3 content.',
              slug: 'v3-article',
              published_at: '2024-01-15',
            },
          ],
        }),
      });

      const results = await plugin.ingestFromStrapi({
        baseUrl: 'https://my-strapi.com',
        contentTypes: ['articles'],
        mappings: {
          articles: {
            content: 'content',
            useAttributes: false, // Strapi v3
          },
        },
      });

      expect(results[0].success).toBe(true);
    });
  });

  // ==========================================================================
  // Web Crawling Tests
  // ==========================================================================

  describe('extractLinks (recursive-crawl support)', () => {
    beforeEach(() => {
      mockFetch.mockReset();
      mongoLedger.mockFindOne.mockResolvedValue(null);
    });

    const HUB_HTML = `<html><head><title>Hub</title></head><body>
      <article>This hub page has more than enough text content to clear the minimum indexable threshold used by the crawler.</article>
      <a href="https://example.com/a">A</a>
      <a href="/b">B (relative)</a>
      <a href="https://example.com/a#section">A again with fragment</a>
      <a href="https://other.com/x">external</a>
      <a href="mailto:hi@example.com">mail</a>
      <a href="tel:+123">phone</a>
    </body></html>`;

    it('returns same-origin internal links in pageStatuses when extractLinks is set', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => HUB_HTML,
      });

      const result = await plugin.ingestFromUrls(
        ['https://example.com/'],
        { extractLinks: true },
        { agentId: 'agent-1' }
      );

      const links = result.metadata?.pageStatuses?.[0]?.links;
      expect(links).toEqual(['https://example.com/a', 'https://example.com/b']);
      // External, mailto, tel excluded; fragment deduped.
      expect(links).not.toContain('https://other.com/x');
    });

    it('respects maxLinksPerPage', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => HUB_HTML,
      });

      const result = await plugin.ingestFromUrls(
        ['https://example.com/'],
        { extractLinks: true, maxLinksPerPage: 1 },
        { agentId: 'agent-1' }
      );

      expect(result.metadata?.pageStatuses?.[0]?.links).toHaveLength(1);
    });

    it('omits links when extractLinks is not set', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => HUB_HTML,
      });

      const result = await plugin.ingestFromUrls(
        ['https://example.com/'],
        {},
        { agentId: 'agent-1' }
      );

      expect(result.metadata?.pageStatuses?.[0]?.links).toBeUndefined();
    });
  });

  describe('ingestFromSitemap', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('should require sitemapUrl or baseUrl', async () => {
      const result = await plugin.ingestFromSitemap({});
      expect(result.success).toBe(false);
      expect(result.errors?.[0].error).toContain('sitemapUrl or baseUrl is required');
    });

    it('should auto-discover sitemap from baseUrl', async () => {
      // Sitemap fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0" encoding="UTF-8"?>
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>https://example.com/page1</loc></url>
            <url><loc>https://example.com/page2</loc></url>
          </urlset>`,
      });

      // Page crawls
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => `<html><head><title>Page 1</title></head><body><article>This is the content of page 1 with enough text to pass the minimum threshold.</article></body></html>`,
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => `<html><head><title>Page 2</title></head><body><article>This is the content of page 2 with enough text to pass the minimum threshold.</article></body></html>`,
      });

      const result = await plugin.ingestFromSitemap({
        baseUrl: 'https://example.com',
        maxPages: 10,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/sitemap.xml',
        expect.any(Object)
      );
    });

    it('should handle sitemap index (nested sitemaps)', async () => {
      // Sitemap index
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0" encoding="UTF-8"?>
          <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
          </sitemapindex>`,
      });

      // Nested sitemap
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0" encoding="UTF-8"?>
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>https://example.com/about</loc></url>
          </urlset>`,
      });

      // Page crawl
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => `<html><body><main>About us content that is long enough to be indexed.</main></body></html>`,
      });

      const result = await plugin.ingestFromSitemap({
        sitemapUrl: 'https://example.com/sitemap.xml',
        maxPages: 10,
      });

      expect(result.urlsCrawled).toBeGreaterThanOrEqual(0);
    });

    it('should filter URLs by excludePatterns', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0" encoding="UTF-8"?>
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>https://example.com/page</loc></url>
            <url><loc>https://example.com/admin/settings</loc></url>
            <url><loc>https://example.com/cart</loc></url>
          </urlset>`,
      });

      // Only non-excluded page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => `<html><body><main>Main page content that passes the threshold.</main></body></html>`,
      });

      const result = await plugin.ingestFromSitemap({
        sitemapUrl: 'https://example.com/sitemap.xml',
        excludePatterns: ['/admin', '/cart'],
      });

      // Should skip admin and cart
      expect(result.urlsCrawled).toBeLessThanOrEqual(1);
    });

    it('should infer type from URL patterns', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0" encoding="UTF-8"?>
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>https://example.com/blog/my-post</loc></url>
          </urlset>`,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => `<html><body><article>Blog post content that is definitely long enough.</article></body></html>`,
      });

      const result = await plugin.ingestFromSitemap({
        sitemapUrl: 'https://example.com/sitemap.xml',
        typeFromUrl: {
          '/blog/': 'blog',
          '/projects/': 'project',
        },
      });

      expect(result.success).toBe(true);
    });
  });

  describe('ingestFromUrls', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('should crawl a list of URLs', async () => {
      // Mock both URL fetches
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'text/html' },
          text: async () => `<html><body><main>About page with sufficient content for indexing that needs to be long enough.</main></body></html>`,
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'text/html' },
          text: async () => `<html><body><main>Contact page with enough content for indexing that needs to be long enough.</main></body></html>`,
        });

      const result = await plugin.ingestFromUrls([
        'https://example.com/about',
        'https://example.com/contact',
      ], {
        type: 'page',
        concurrency: 1, // Process one at a time for predictable test
        renderOptions: { minContentLength: 50 },
      });

      expect(result.urlsCrawled).toBe(2);
    });

    it('should use custom content selector', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => `<html><body>
          <nav>Navigation</nav>
          <div class="custom-content">This is the actual content we want to extract that needs to be long enough.</div>
          <footer>Footer</footer>
        </body></html>`,
      });

      const result = await plugin.ingestFromUrls([
        'https://example.com/page',
      ], {
        contentSelector: '.custom-content',
      });

      expect(result.success).toBe(true);
    });

    it('should handle failed URLs gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => `<html><body><main>Good page content here that is long enough for indexing.</main></body></html>`,
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const result = await plugin.ingestFromUrls([
        'https://example.com/good',
        'https://example.com/missing',
      ], {
        renderOptions: { minContentLength: 50 },
      });

      expect(result.urlsCrawled).toBe(1);
      expect(result.urlsFailed).toBe(1);
    });
  });

  describe('ingestFromWebsite', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('should require baseUrl', async () => {
      const result = await plugin.ingestFromWebsite({ baseUrl: '' });
      expect(result.success).toBe(false);
      expect(result.errors?.[0].error).toContain('baseUrl is required');
    });

    it('should reject invalid baseUrl', async () => {
      const result = await plugin.ingestFromWebsite({ baseUrl: 'not-a-url' });
      expect(result.success).toBe(false);
      expect(result.errors?.[0].error).toContain('Invalid baseUrl');
    });

    it('should discover URLs from robots sitemap then crawl', async () => {
      const longArticle = `<article>${'paragraph text '.repeat(20)}</article>`;
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: async () => 'Sitemap: https://example.com/site-map.xml',
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => `<?xml version="1.0" encoding="UTF-8"?>
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/docs/page</loc></url>
            </urlset>`,
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'text/html' },
          text: async () => `<html><head><title>Docs</title></head><body>${longArticle}</body></html>`,
        });

      const result = await plugin.ingestFromWebsite({
        baseUrl: 'https://example.com/',
        maxPages: 5,
        delayMs: 0,
        concurrency: 1,
      });

      expect(result.success).toBe(true);
      expect(result.urlsCrawled).toBeGreaterThanOrEqual(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/robots.txt',
        expect.any(Object)
      );
    });

    it('should fall back to internal link BFS when sitemaps yield no URLs', async () => {
      const body = `<main>${'fallback crawl content '.repeat(15)}</main>`;
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: async () => '',
        });
      for (let i = 0; i < 4; i++) {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      }
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'text/html' },
          text: async () =>
            `<html><body><a href="/inner">Inner</a><p>${'home '.repeat(30)}</p></body></html>`,
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'text/html' },
          text: async () => `<html><body>${body}</body></html>`,
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'text/html' },
          text: async () =>
            `<html><body><a href="/inner">Inner</a><p>${'home '.repeat(30)}</p></body></html>`,
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'text/html' },
          text: async () => `<html><body>${body}</body></html>`,
        });

      const result = await plugin.ingestFromWebsite({
        baseUrl: 'https://example.com/',
        maxPages: 3,
        maxDepth: 2,
        delayMs: 0,
        concurrency: 1,
        debug: { enabled: true, level: 'summary' },
        renderOptions: { minContentLength: 50 },
      });

      expect(result.success).toBe(true);
      expect(result.urlsCrawled).toBeGreaterThanOrEqual(1);
      expect(result.metadata?.discoveryDebug).toBeDefined();
    });
  });

  describe('ingestSinglePageFromUrl', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('should require url', async () => {
      const result = await plugin.ingestSinglePageFromUrl({ url: '' });
      expect(result.success).toBe(false);
      expect(result.errors?.[0].error).toContain('url is required');
    });

    it('should crawl a single URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () =>
          `<html><body><article>${'single page body '.repeat(20)}</article></body></html>`,
      });

      const result = await plugin.ingestSinglePageFromUrl({
        url: 'https://example.com/only',
        timeout: 10000,
      });

      expect(result.urlsCrawled).toBe(1);
      expect(result.success).toBe(true);
    });
  });

  describe('crawl ledger', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('should skip crawl when ledger has fresh indexed row', async () => {
      mongoLedger.mockFindOne.mockResolvedValue({
        lastStatus: 'indexed',
        lastCrawledAt: new Date(),
        contentLength: 400,
        title: 'Cached',
        docId: 'abc',
      });

      const ledgerPlugin = new WebRAGPlugin({
        mongoUri: 'mongodb://localhost:27017',
        dbName: 'test_db',
        openaiApiKey: 'test-key',
        tenantId: 'test-tenant',
        crawlLedger: {
          enabled: true,
          ttlMsIndexed: 7 * 24 * 60 * 60 * 1000,
        },
      });

      const result = await ledgerPlugin.ingestFromUrls(
        ['https://example.com/cached'],
        { type: 'page', concurrency: 1, stripQueryParams: true }
      );

      expect(result.metadata?.counters?.ledgerSkipped).toBe(1);
      expect(result.urlsCrawled).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
      await ledgerPlugin.disconnect();
    });

    it('should list crawl ledger rows', async () => {
      const row = {
        tenantId: 'test-tenant',
        agentId: 'shared',
        urlNormalized: 'https://example.com/a',
        url: 'https://example.com/a',
        domain: 'example.com',
        lastStatus: 'indexed',
        lastCrawledAt: new Date(),
        updatedAt: new Date(),
      };
      mongoLedger.toArrayFind.mockResolvedValueOnce([row]);

      const ledgerPlugin = new WebRAGPlugin({
        mongoUri: 'mongodb://localhost:27017',
        dbName: 'test_db',
        openaiApiKey: 'test-key',
        tenantId: 'test-tenant',
        crawlLedger: { enabled: true },
      });

      const rows = await ledgerPlugin.listCrawlLedger({ limit: 5 });
      expect(rows).toHaveLength(1);
      expect(rows[0].url).toBe('https://example.com/a');
      await ledgerPlugin.disconnect();
    });

    it('should persist ingestionId on ledger upsert when metadata.ingestionId is set', async () => {
      mongoLedger.mockUpdateOne.mockClear();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () =>
          '<html><head><title>Page</title></head><body><p>' +
          'x'.repeat(400) +
          '</p></body></html>',
      });

      const ledgerPlugin = new WebRAGPlugin({
        mongoUri: 'mongodb://localhost:27017',
        dbName: 'test_db',
        openaiApiKey: 'test-key',
        tenantId: 'test-tenant',
        crawlLedger: { enabled: true },
      });

      await ledgerPlugin.ingestFromUrls(
        ['https://example.com/page'],
        {
          type: 'page',
          concurrency: 1,
          stripQueryParams: true,
          metadata: { ingestionId: 'ing-test-1' },
        },
        { agentId: 'agent-1' },
      );

      const ledgerUpsert = mongoLedger.mockUpdateOne.mock.calls.find(
        (call) => call[1]?.$set?.lastStatus !== undefined,
      );
      expect(ledgerUpsert).toBeDefined();
      expect(ledgerUpsert?.[1]?.$set?.ingestionId).toBe('ing-test-1');
      await ledgerPlugin.disconnect();
    });

    it('should filter listCrawlLedger by ingestionId', async () => {
      const mockFind = vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          skip: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });
      mongoLedger.MongoClient.mockImplementation(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        db: vi.fn().mockReturnValue({
          collection: vi.fn().mockReturnValue({
            find: mockFind,
            createIndex: vi.fn().mockResolvedValue('idx'),
            updateOne: mongoLedger.mockUpdateOne,
            bulkWrite: mongoLedger.mockBulkWrite,
            deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
            findOne: mongoLedger.mockFindOne,
          }),
        }),
      }));

      const ledgerPlugin = new WebRAGPlugin({
        mongoUri: 'mongodb://localhost:27017',
        dbName: 'test_db',
        openaiApiKey: 'test-key',
        tenantId: 'test-tenant',
        crawlLedger: { enabled: true },
      });

      await ledgerPlugin.listCrawlLedger({ ingestionId: 'ing-abc', agentId: 'agent-1' });

      expect(mockFind).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'test-tenant',
          agentId: 'agent-1',
          ingestionId: 'ing-abc',
        }),
      );
      await ledgerPlugin.disconnect();
    });

    // ── content-hash change detection ──────────────────────────────────────
    const PAGE_HTML =
      '<html><head><title>Page</title></head><body><p>' +
      'x'.repeat(400) +
      '</p><a href="https://example.com/other">next</a></body></html>';

    it('stamps contentHash + hashAlgo on the ledger for a newly indexed page', async () => {
      mongoLedger.mockFindOne.mockResolvedValue(null);
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => PAGE_HTML,
      });

      const ledgerPlugin = new WebRAGPlugin({
        mongoUri: 'mongodb://localhost:27017',
        dbName: 'test_db',
        openaiApiKey: 'test-key',
        tenantId: 'test-tenant',
        crawlLedger: { enabled: true },
      });

      const result = await ledgerPlugin.ingestFromUrls(
        ['https://example.com/page'],
        { type: 'page', concurrency: 1, stripQueryParams: true, metadata: { ingestionId: 'ing-add' } },
        { agentId: 'a1' },
      );

      expect(openaiMock.create).toHaveBeenCalled();
      expect(result.metadata?.counters?.added).toBe(1);
      // The hash is stamped after the ingest, once the embedding already exists.
      const hashStamp = mongoLedger.mockBulkWrite.mock.calls.find(
        ([operations]) => operations.some((op: any) => op.updateOne?.update?.$set?.contentHash),
      );
      const hashUpdate = hashStamp?.[0].find(
        (op: any) => op.updateOne?.update?.$set?.contentHash,
      )?.updateOne.update.$set;
      expect(hashUpdate).toBeDefined();
      expect(hashUpdate?.hashAlgo).toBe('sha256-v1');
      await ledgerPlugin.disconnect();
    });

    it('re-crawl with unchanged content refreshes the ledger but skips embedding (keeps links)', async () => {
      const ledgerPlugin = new WebRAGPlugin({
        mongoUri: 'mongodb://localhost:27017',
        dbName: 'test_db',
        openaiApiKey: 'test-key',
        tenantId: 'test-tenant',
        crawlLedger: { enabled: true },
      });

      // Pass 1 — new page: crawled, embedded, hash stamped. Capture the exact hash written.
      mongoLedger.mockFindOne.mockResolvedValue(null);
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => PAGE_HTML,
      });
      await ledgerPlugin.ingestFromUrls(
        ['https://example.com/page'],
        { type: 'page', concurrency: 1, stripQueryParams: true, extractLinks: true, metadata: { ingestionId: 'ing-1' } },
        { agentId: 'a1' },
      );
      // The hash is stamped after the ingest, once the embedding already exists.
      const firstHashStamp = mongoLedger.mockBulkWrite.mock.calls.find(
        ([operations]) => operations.some((op: any) => op.updateOne?.update?.$set?.contentHash),
      );
      const contentHash = firstHashStamp?.[0].find(
        (op: any) => op.updateOne?.update?.$set?.contentHash,
      )?.updateOne.update.$set.contentHash as string;
      expect(contentHash).toBeDefined();
      expect(openaiMock.create).toHaveBeenCalled();

      // Pass 2 — same content, ledger now has the matching hash → unchanged.
      openaiMock.create.mockClear();
      mongoLedger.mockFindOne.mockResolvedValue({
        lastStatus: 'indexed',
        lastCrawledAt: new Date(),
        hashAlgo: 'sha256-v1',
        contentHash,
      });

      const result = await ledgerPlugin.ingestFromUrls(
        ['https://example.com/page'],
        { type: 'page', concurrency: 1, stripQueryParams: true, extractLinks: true, metadata: { ingestionId: 'ing-2' } },
        { agentId: 'a1', forceRecrawl: true } as any, // bypass TTL → exercise the hash gate
      );

      expect(openaiMock.create).not.toHaveBeenCalled();
      expect(result.metadata?.counters?.unchanged).toBe(1);
      expect(result.metadata?.counters?.changed).toBe(0);
      expect(result.indexed).toBe(0);
      expect(result.urlsCrawled).toBe(1);
      const page = result.metadata?.pageStatuses?.[0];
      expect(page?.changeStatus).toBe('unchanged');
      // Critical: unchanged pages must still surface links so the caller's BFS keeps discovering URLs.
      expect(page?.links?.length).toBeGreaterThan(0);
      await ledgerPlugin.disconnect();
    });

    it('re-crawl with changed content re-embeds and updates the stored hash', async () => {
      mongoLedger.mockFindOne.mockResolvedValue({
        lastStatus: 'indexed',
        lastCrawledAt: new Date(),
        hashAlgo: 'sha256-v1',
        contentHash: 'stale-old-hash',
      });
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => PAGE_HTML,
      });

      const ledgerPlugin = new WebRAGPlugin({
        mongoUri: 'mongodb://localhost:27017',
        dbName: 'test_db',
        openaiApiKey: 'test-key',
        tenantId: 'test-tenant',
        crawlLedger: { enabled: true },
      });

      const result = await ledgerPlugin.ingestFromUrls(
        ['https://example.com/page'],
        { type: 'page', concurrency: 1, stripQueryParams: true, metadata: { ingestionId: 'ing-3' } },
        { agentId: 'a1', forceRecrawl: true } as any,
      );

      expect(openaiMock.create).toHaveBeenCalled();
      expect(result.metadata?.counters?.changed).toBe(1);
      const upsert = mongoLedger.mockUpdateOne.mock.calls.find(
        (c) => c[1]?.$set?.lastStatus === 'indexed' && c[1]?.$set?.contentHash,
      );
      expect(upsert?.[1]?.$set?.contentHash).not.toBe('stale-old-hash');
      await ledgerPlugin.disconnect();
    });

    it('treats a legacy indexed ledger row without contentHash as new (re-embeds once)', async () => {
      mongoLedger.mockFindOne.mockResolvedValue({
        lastStatus: 'indexed',
        lastCrawledAt: new Date(),
        contentLength: 400, // legacy row: no contentHash / hashAlgo
      });
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => PAGE_HTML,
      });

      const ledgerPlugin = new WebRAGPlugin({
        mongoUri: 'mongodb://localhost:27017',
        dbName: 'test_db',
        openaiApiKey: 'test-key',
        tenantId: 'test-tenant',
        crawlLedger: { enabled: true },
      });

      const result = await ledgerPlugin.ingestFromUrls(
        ['https://example.com/page'],
        { type: 'page', concurrency: 1, stripQueryParams: true, metadata: { ingestionId: 'ing-4' } },
        { agentId: 'a1', forceRecrawl: true } as any,
      );

      expect(openaiMock.create).toHaveBeenCalled();
      expect(result.metadata?.counters?.unchanged).toBe(0);
      expect(result.metadata?.counters?.added).toBe(1);
      await ledgerPlugin.disconnect();
    });
  });

  describe('render / ledger diagnostics (helpers)', () => {
    it('diagFromRenderedAttempt: infra failure is render_error with message', () => {
      const p = plugin as unknown as {
        diagFromRenderedAttempt: (
          doc: null,
          hint: number,
          renderFailure: string | undefined,
          blocked: boolean | undefined,
          ok: string,
          fail: string
        ) => { diag?: { reason?: string; errorMessage?: string } };
      };
      const r = p.diagFromRenderedAttempt(
        null,
        0,
        'page.goto: Timeout 30000ms exceeded',
        undefined,
        'render_ok',
        'render_failed'
      );
      expect(r.diag?.reason).toBe('render_error');
      expect(r.diag?.errorMessage).toContain('Timeout');
    });

    it('diagFromRenderedAttempt: captcha path is blocked_suspected', () => {
      const p = plugin as unknown as {
        diagFromRenderedAttempt: (
          doc: null,
          hint: number,
          renderFailure: string | undefined,
          blocked: boolean | undefined,
          ok: string,
          fail: string
        ) => { diag?: { reason?: string } };
      };
      const r = p.diagFromRenderedAttempt(
        null,
        0,
        undefined,
        true,
        'render_ok',
        'render_failed'
      );
      expect(r.diag?.reason).toBe('blocked_suspected');
    });

    it('toLedgerStatus maps render_error to error', () => {
      const p = plugin as unknown as {
        toLedgerStatus: (doc: null, diag?: { reason?: string }) => string;
      };
      expect(p.toLedgerStatus(null, { reason: 'render_error' })).toBe('error');
      expect(p.toLedgerStatus(null, { reason: 'too_small' })).toBe('too_small');
    });
  });

  describe('ingestFromRSS', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('should parse RSS 2.0 feed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0">
            <channel>
              <title>My Blog</title>
              <item>
                <title>First Post</title>
                <link>https://myblog.com/first-post</link>
                <description>This is the description of the first post with enough content.</description>
                <pubDate>Mon, 15 Jan 2024 10:00:00 GMT</pubDate>
                <author>John Doe</author>
                <category>Tech</category>
              </item>
              <item>
                <title>Second Post</title>
                <link>https://myblog.com/second-post</link>
                <description>This is the description of the second post with enough content.</description>
              </item>
            </channel>
          </rss>`,
      });

      const result = await plugin.ingestFromRSS({
        feedUrl: 'https://myblog.com/feed/',
      });

      expect(result.success).toBe(true);
      expect(result.indexed).toBe(2);
    });

    it('should parse RSS with CDATA content', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
            <channel>
              <item>
                <title>Post with CDATA</title>
                <link>https://myblog.com/post</link>
                <content:encoded><![CDATA[<p>This is rich HTML content with <strong>formatting</strong> that needs to be stripped.</p>]]></content:encoded>
              </item>
            </channel>
          </rss>`,
      });

      const result = await plugin.ingestFromRSS({
        feedUrl: 'https://myblog.com/feed/',
      });

      expect(result.success).toBe(true);
      expect(result.indexed).toBe(1);
    });

    it('should parse Atom feed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0" encoding="UTF-8"?>
          <feed xmlns="http://www.w3.org/2005/Atom">
            <title>My Atom Feed</title>
            <entry>
              <title>Atom Post</title>
              <link rel="alternate" href="https://myblog.com/atom-post"/>
              <id>urn:uuid:1234</id>
              <published>2024-01-15T10:00:00Z</published>
              <content>This is the content of an Atom feed entry with enough text.</content>
            </entry>
          </feed>`,
      });

      const result = await plugin.ingestFromRSS({
        feedUrl: 'https://myblog.com/feed.atom',
      });

      expect(result.success).toBe(true);
      expect(result.indexed).toBe(1);
    });

    it('should fetch full content when configured', async () => {
      // RSS feed
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0">
            <channel>
              <item>
                <title>Post</title>
                <link>https://myblog.com/post</link>
                <description>Short excerpt...</description>
              </item>
            </channel>
          </rss>`,
      });

      // Full page fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => `<html><body><article>This is the full article content that is much longer than the excerpt.</article></body></html>`,
      });

      const result = await plugin.ingestFromRSS({
        feedUrl: 'https://myblog.com/feed/',
        fetchFullContent: true,
        contentSelector: 'article',
      });

      expect(result.urlsCrawled).toBe(1);
    });

    it('should handle feed fetch errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const result = await plugin.ingestFromRSS({
        feedUrl: 'https://myblog.com/missing-feed',
      });

      expect(result.success).toBe(false);
      expect(result.errors?.[0].error).toContain('404');
    });

    it('should strip HTML from content', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0">
            <channel>
              <item>
                <title>HTML Post</title>
                <link>https://myblog.com/post</link>
                <description>&lt;p&gt;Paragraph with &lt;strong&gt;bold&lt;/strong&gt; text.&lt;/p&gt;</description>
              </item>
            </channel>
          </rss>`,
      });

      const result = await plugin.ingestFromRSS({
        feedUrl: 'https://myblog.com/feed/',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('ingest: borrado de chunks previos', () => {
    it('scopes the deleteMany by sourceId when the document carries one', async () => {
      await plugin.ingest(
        [
          {
            id: 'doc-a',
            content: 'x'.repeat(5000),
            metadata: { type: 'detail', url: 'https://a.test/p/1', sourceId: 'src-1' },
          },
        ],
        { agentId: 'agent-1' },
      );

      const call = mongoLedger.mockDeleteMany.mock.calls[0][0];
      // The id lives inside the $or — it has to delete by both shapes — so it is asserted apart
      // from the scope. Asserting `documentId` at the top level fails against the correct
      // implementation.
      expect(call.$or).toEqual([{ documentId: 'doc-a' }, { id: 'doc-a' }]);
      expect(call.agentId).toBe('agent-1');
      expect(call['metadata.sourceId']).toBe('src-1');
    });

    it('scopes to the legacy scope when the document carries no sourceId', async () => {
      // The field goes anyway, as null: without it the delete would stop filtering by source and
      // would reach the chunks of anyone sharing the id.
      mongoLedger.mockDeleteMany.mockClear();
      await plugin.ingest(
        [{ id: 'doc-z', content: 'x'.repeat(5000), metadata: { type: 'detail', url: 'https://a.test/p/9' } }],
        { agentId: 'agent-1' },
      );
      expect(mongoLedger.mockDeleteMany.mock.calls[0][0]['metadata.sourceId']).toBeNull();
    });

    it('does not touch the chunks of another source with the same documentId', async () => {
      mongoLedger.mockDeleteMany.mockClear();
      await plugin.ingest(
        [{ id: 'compartido', content: 'x'.repeat(5000), metadata: { type: 'detail', url: 'https://a.test/p/1', sourceId: 'src-2' } }],
        { agentId: 'agent-1' },
      );
      expect(mongoLedger.mockDeleteMany.mock.calls[0][0]['metadata.sourceId']).toBe('src-2');
    });

    it('deletes even when the document does NOT end up chunked', async () => {
      mongoLedger.mockDeleteMany.mockClear();
      await plugin.ingest(
        [
          {
            id: 'doc-b',
            content: 'corto',
            metadata: { type: 'detail', url: 'https://a.test/p/2', sourceId: 'src-1' },
          },
        ],
        { agentId: 'agent-1' },
      );

      expect(mongoLedger.mockDeleteMany).toHaveBeenCalled();
    });
  });

  describe('ledger: identity index', () => {
    it('declares the unique index including sourceId', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => `<html><body>${'y'.repeat(5000)}</body></html>`,
      });
      // The index is declared when the ledger is used; ingest() never reaches getLedgerCollection().
      await plugin.ingestFromUrls(
        ['https://a.test/p/3'],
        { crawlLedger: { enabled: true } },
        { agentId: 'agent-1' },
      );

      const uniqueCalls = mongoLedger.mockCreateIndex.mock.calls.filter(
        ([, opts]: [unknown, { unique?: boolean } | undefined]) => opts?.unique === true,
      );
      expect(uniqueCalls.length).toBeGreaterThan(0);
      expect(uniqueCalls[0][0]).toEqual({ tenantId: 1, agentId: 1, sourceId: 1, urlNormalized: 1 });
    });

    it('two sources with the same URL do not share a ledger row', async () => {
      mongoLedger.mockUpdateOne.mockClear();
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => `<html><body>${'z'.repeat(5000)}</body></html>`,
      });
      // sourceId viaja en config.metadata, no en options.metadata.
      await plugin.ingestFromUrls(['https://a.test/p/1'], {
        crawlLedger: { enabled: true },
        metadata: { sourceId: 'src-1' },
      }, {
        agentId: 'agent-1',
      });
      await plugin.ingestFromUrls(['https://a.test/p/1'], {
        crawlLedger: { enabled: true },
        metadata: { sourceId: 'src-2' },
      }, {
        agentId: 'agent-1',
      });
      const scopes = mongoLedger.mockUpdateOne.mock.calls.map(([filter]) => filter.sourceId);
      expect(scopes).toContain('src-1');
      expect(scopes).toContain('src-2');
      // And no call was left without the field.
      expect(mongoLedger.mockUpdateOne.mock.calls.every(([filter]) => 'sourceId' in filter)).toBe(true);
    });
  });

  describe('crawlUrls: ordering between hash and embeddings', () => {
    it('does not store the contentHash if the ingest fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => `<html><body>${'z'.repeat(5000)}</body></html>`,
      });
      // The crawl brings in a new page, but embedding blows up.
      vi.spyOn(plugin as any, 'generateEmbeddingsBatch').mockRejectedValue(new Error('openai down'));

      await plugin.ingestFromUrls(['https://a.test/p/9'], { crawlLedger: { enabled: true } }, {
        agentId: 'agent-1',
      });

      const wroteHash = mongoLedger.mockUpdateOne.mock.calls.some(
        ([, update]: [unknown, { $set?: Record<string, unknown> }]) =>
          update?.$set?.contentHash !== undefined,
      );
      expect(wroteHash).toBe(false);
      const stampedHash = mongoLedger.mockBulkWrite.mock.calls.some(
        ([operations]) => operations.some((op: any) => op.updateOne?.update?.$set?.contentHash !== undefined),
      );
      expect(stampedHash).toBe(false);
    });
  });

  describe('affirmPages', () => {
    it('refreshes ingestionId and lastCrawledAt without touching the contentHash', async () => {
      mongoLedger.mockUpdateOne.mockClear();

      const result = await plugin.affirmPages(
        [{ url: 'https://a.test/p/1', sourceId: 'src-1', ingestionId: 'ing-9' }],
        { stripQueryParams: true },
        { agentId: 'agent-1' },
      );

      expect(result.affirmed).toBe(1);
      expect(result.pages).toEqual([
        expect.objectContaining({
          url: 'https://a.test/p/1',
          urlNormalized: expect.any(String),
          outcome: 'affirmed',
        }),
      ]);
      const [, update] = mongoLedger.mockUpdateOne.mock.calls[0];
      expect(update.$set.ingestionId).toBe('ing-9');
      expect(update.$set.lastCrawledAt).toBeInstanceOf(Date);
      expect(update.$set.contentHash).toBeUndefined();
    });

    it('performs no writes for an empty list', async () => {
      mongoLedger.mockUpdateOne.mockClear();
      const result = await plugin.affirmPages([], {}, { agentId: 'agent-1' });
      expect(result.affirmed).toBe(0);
      expect(result.pages).toEqual([]);
      expect(mongoLedger.mockUpdateOne).not.toHaveBeenCalled();
    });

    it('keeps the position of an invalid URL without writing a raw row', async () => {
      mongoLedger.mockUpdateOne.mockClear();

      const result = await plugin.affirmPages(
        [{ url: 'no es una url', sourceId: 'src-1', ingestionId: 'ing-9' }],
        {},
        { agentId: 'agent-1' },
      );

      expect(result).toEqual({
        affirmed: 0,
        pages: [{
          url: 'no es una url',
          urlNormalized: null,
          outcome: 'failed',
          errorCode: 'invalid_url',
        }],
      });
      expect(mongoLedger.mockUpdateOne).not.toHaveBeenCalled();
    });
  });

  describe('ingestFromHtml', () => {
    const page = (over: Partial<any> = {}) => ({
      url: 'https://a.test/p/1',
      status: 'ok' as const,
      html: '<html><head><title>Ficha</title></head><body>' + 'z'.repeat(3000) + '</body></html>',
      sourceId: 'src-1',
      ingestionId: 'ing-1',
      ...over,
    });

    it('returns one result per page, in order', async () => {
      const result = await plugin.ingestFromHtml(
        [page(), page({ url: 'https://a.test/p/2' })],
        {},
        { agentId: 'agent-1' },
      );
      expect(result.pages).toHaveLength(2);
      expect(result.pages[0].url).toBe('https://a.test/p/1');
      expect(result.pages[1].url).toBe('https://a.test/p/2');
    });

    it('keeps every position when a URL cannot be normalized', async () => {
      mongoLedger.mockUpdateOne.mockClear();
      const result = await plugin.ingestFromHtml(
        [page(), page({ url: 'no es una url' }), page({ url: 'https://a.test/p/3' })],
        {},
        { agentId: 'agent-1' },
      );

      expect(result.pages).toHaveLength(3);
      expect(result.pages.map((entry) => entry.url)).toEqual([
        'https://a.test/p/1',
        'no es una url',
        'https://a.test/p/3',
      ]);
      expect(result.pages[1]).toMatchObject({
        urlNormalized: null,
        outcome: 'failed',
        errorCode: 'invalid_url',
      });
      expect(mongoLedger.mockUpdateOne.mock.calls.some(
        ([, update]) => update.$set.url === 'no es una url',
      )).toBe(false);
    });

    it('marks a new page as added and exposes its eligibility without persisting fetchHash', async () => {
      const result = await plugin.ingestFromHtml(
        [page({ fetchHash: 'fetch-hash-del-adquiriente' })],
        {},
        { agentId: 'agent-1' },
      );
      expect(result.pages[0].outcome).toBe('added');
      expect(typeof result.pages[0].cardEligible).toBe('boolean');
      expect(result.pages[0].documentId?.startsWith('src-1:')).toBe(true);
      const persistedFetchHash = [
        ...mongoLedger.mockUpdateOne.mock.calls,
        ...mongoLedger.mockBulkWrite.mock.calls,
      ].some((call) => JSON.stringify(call).includes('fetch-hash-del-adquiriente'));
      expect(persistedFetchHash).toBe(false);
    });

    it('does not re-embed when the contentHash did not move', async () => {
      const first = await plugin.ingestFromHtml([page()], {}, { agentId: 'agent-1' });
      const hash = first.pages[0].contentHash!;
      mongoLedger.mockFindOne.mockResolvedValue({
        contentHash: hash,
        hashAlgo: 'sha256-v1',
        lastStatus: 'indexed',
      });

      const second = await plugin.ingestFromHtml([page()], {}, { agentId: 'agent-1' });
      expect(second.pages[0].outcome).toBe('unchanged');
      expect(second.indexed).toBe(0);
    });

    it('does not try to extract a page the acquirer could not fetch', async () => {
      const result = await plugin.ingestFromHtml(
        [page({ status: 'robots_denied', html: undefined })],
        {},
        { agentId: 'agent-1' },
      );
      expect(result.pages[0].outcome).toBe('skipped_status');
      expect(result.indexed).toBe(0);
    });
  });
});
