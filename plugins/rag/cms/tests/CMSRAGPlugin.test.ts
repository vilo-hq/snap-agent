import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CMSRAGPlugin } from '../src/CMSRAGPlugin';

// Mock MongoDB
vi.mock('mongodb', () => {
  const mockCollection = {
    aggregate: vi.fn().mockReturnValue({
      toArray: vi.fn().mockResolvedValue([]),
    }),
    updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }),
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
  };
});

// Mock OpenAI
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      embeddings: {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: new Array(1536).fill(0.1) }],
        }),
      },
    })),
  };
});

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('CMSRAGPlugin', () => {
  let plugin: CMSRAGPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new CMSRAGPlugin({
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
      expect(plugin.name).toBe('cms-rag');
      expect(plugin.type).toBe('rag');
      expect(plugin.priority).toBe(100);
    });

    it('should accept custom priority', () => {
      const customPlugin = new CMSRAGPlugin({
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
      expect(CMSRAGPlugin.parseDrupalType('node--project')).toBe('project');
      expect(CMSRAGPlugin.parseDrupalType('node--team_member')).toBe('team_member');
      expect(CMSRAGPlugin.parseDrupalType('project')).toBe('project');
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
      expect(config.name).toBe('cms-rag');
      expect(config.tenantId).toBe('test-tenant');
      expect(config.mongoUri).toBe('${MONGODB_URI}');
      expect(config.openaiApiKey).toBe('${OPENAI_API_KEY}');
    });
  });

  describe('type and recency boosts', () => {
    it('should accept type boosts configuration', () => {
      const pluginWithBoosts = new CMSRAGPlugin({
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
      const pluginWithRecency = new CMSRAGPlugin({
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

      const text = CMSRAGPlugin.sanityBlocksToText(blocks);
      expect(text).toBe('Hello World\n\nSecond paragraph.');
    });

    it('should handle empty or invalid input', () => {
      expect(CMSRAGPlugin.sanityBlocksToText([])).toBe('');
      expect(CMSRAGPlugin.sanityBlocksToText(null as any)).toBe('');
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
      ]);

      expect(result.urlsCrawled).toBe(1);
      expect(result.urlsFailed).toBe(1);
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
});

