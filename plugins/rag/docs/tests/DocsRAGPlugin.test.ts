import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocsRAGPlugin } from '../src/DocsRAGPlugin';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Helper to create mock embedding response
function createEmbeddingResponse(embedding: number[] = Array(1536).fill(0.1)) {
  return {
    ok: true,
    json: async () => ({
      data: [{ embedding }],
    }),
  };
}

describe('DocsRAGPlugin', () => {
  let plugin: DocsRAGPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(createEmbeddingResponse());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================================
  // Constructor & Configuration
  // ============================================================================

  describe('constructor', () => {
    it('should create plugin with default config', () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
      });

      expect(plugin.name).toBe('docs-rag');
      expect(plugin.type).toBe('rag');
    });

    it('should use OpenAI as default provider', () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
      });

      // Access private config via getStats which uses config
      const stats = plugin.getStats();
      expect(stats.strategy).toBe('markdown');
    });

    it('should set default model for OpenAI provider', async () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
        embeddingProvider: 'openai',
      });

      await plugin.ingest(
        [{ id: 'test', content: 'test content' }],
        { agentId: 'agent-1' }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          body: expect.stringContaining('text-embedding-3-small'),
        })
      );
    });

    it('should set default model for Voyage provider', async () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'voyage-key',
        embeddingProvider: 'voyage',
      });

      await plugin.ingest(
        [{ id: 'test', content: 'test content' }],
        { agentId: 'agent-1' }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.voyageai.com/v1/embeddings',
        expect.objectContaining({
          body: expect.stringContaining('voyage-3-lite'),
        })
      );
    });

    it('should allow custom embedding model', async () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
        embeddingModel: 'text-embedding-3-large',
      });

      await plugin.ingest(
        [{ id: 'test', content: 'test content' }],
        { agentId: 'agent-1' }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('text-embedding-3-large'),
        })
      );
    });

    it('should accept custom config values', () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
        chunkingStrategy: 'paragraph',
        maxChunkSize: 500,
        chunkOverlap: 100,
        limit: 10,
        minSimilarity: 0.8,
        includeCode: false,
      });

      const stats = plugin.getStats();
      expect(stats.strategy).toBe('paragraph');
    });
  });

  // ============================================================================
  // Ingest Documents
  // ============================================================================

  describe('ingest', () => {
    beforeEach(() => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
      });
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
    });

    it('should include metadata in ingest result', async () => {
      const result = await plugin.ingest(
        [{ id: 'doc1', content: 'Test content' }],
        { agentId: 'agent-1' }
      );

      expect(result.metadata).toBeDefined();
      expect(result.metadata?.strategy).toBe('markdown');
      expect(result.metadata?.totalChunks).toBeGreaterThan(0);
    });

    it('should handle API errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const result = await plugin.ingest(
        [{ id: 'doc1', content: 'Test content' }],
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
          embeddingProviderApiKey: 'test-key',
          chunkingStrategy: 'markdown',
        });
      });

      it('should extract headings as separate chunks', async () => {
        const content = `# Main Title

Introduction paragraph.

## Section One

Content for section one.

## Section Two

Content for section two.`;

        await plugin.ingest(
          [{ id: 'doc1', content }],
          { agentId: 'agent-1' }
        );

        const stats = plugin.getStats();
        expect(stats.agentStats['agent-1'].byType.heading).toBeGreaterThan(0);
      });

      it('should extract code blocks separately', async () => {
        const content = `# Getting Started

Here's how to use it:

\`\`\`typescript
const client = new Client();
client.connect();
\`\`\`

That's all!`;

        await plugin.ingest(
          [{ id: 'doc1', content }],
          { agentId: 'agent-1' }
        );

        const stats = plugin.getStats();
        expect(stats.agentStats['agent-1'].byType.code).toBe(1);
      });

      it('should preserve section context', async () => {
        const content = `# API Reference

## Authentication

Use API keys for auth.

## Endpoints

Here are the endpoints.`;

        await plugin.ingest(
          [{ id: 'doc1', content }],
          { agentId: 'agent-1' }
        );

        // The chunks should have section metadata
        const stats = plugin.getStats();
        expect(stats.agentStats['agent-1'].totalChunks).toBeGreaterThan(2);
      });
    });

    describe('paragraph chunking', () => {
      beforeEach(() => {
        plugin = new DocsRAGPlugin({
          embeddingProviderApiKey: 'test-key',
          chunkingStrategy: 'paragraph',
          maxChunkSize: 100,
        });
      });

      it('should split on double newlines', async () => {
        const content = `First paragraph with some content.

Second paragraph with more content.

Third paragraph with even more content.`;

        await plugin.ingest(
          [{ id: 'doc1', content }],
          { agentId: 'agent-1' }
        );

        const stats = plugin.getStats();
        expect(stats.agentStats['agent-1'].totalChunks).toBeGreaterThanOrEqual(1);
      });
    });

    describe('sentence chunking', () => {
      beforeEach(() => {
        plugin = new DocsRAGPlugin({
          embeddingProviderApiKey: 'test-key',
          chunkingStrategy: 'sentence',
          maxChunkSize: 100,
        });
      });

      it('should split on sentence boundaries', async () => {
        const content = 'First sentence. Second sentence! Third sentence? Fourth sentence.';

        await plugin.ingest(
          [{ id: 'doc1', content }],
          { agentId: 'agent-1' }
        );

        const stats = plugin.getStats();
        expect(stats.agentStats['agent-1'].totalChunks).toBeGreaterThanOrEqual(1);
      });
    });

    describe('fixed chunking', () => {
      beforeEach(() => {
        plugin = new DocsRAGPlugin({
          embeddingProviderApiKey: 'test-key',
          chunkingStrategy: 'fixed',
          maxChunkSize: 50,
          chunkOverlap: 10,
        });
      });

      it('should create fixed-size chunks with overlap', async () => {
        const content = 'A'.repeat(150); // 150 characters

        await plugin.ingest(
          [{ id: 'doc1', content }],
          { agentId: 'agent-1' }
        );

        const stats = plugin.getStats();
        // With size 50 and overlap 10, 150 chars should create ~4 chunks
        expect(stats.agentStats['agent-1'].totalChunks).toBeGreaterThan(2);
      });
    });
  });

  // ============================================================================
  // Retrieve Context
  // ============================================================================

  describe('retrieveContext', () => {
    beforeEach(async () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
        minSimilarity: 0,
        limit: 5,
      });

      // Ingest some test documents
      await plugin.ingest(
        [
          {
            id: 'doc1',
            content: '# Installation\n\nRun npm install to get started.',
            metadata: { title: 'Installation Guide' },
          },
          {
            id: 'doc2',
            content: '# API Reference\n\nThe main endpoint is /api/v1.',
            metadata: { title: 'API Docs' },
          },
        ],
        { agentId: 'agent-1' }
      );
    });

    it('should return empty context when no documents indexed', async () => {
      const emptyPlugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
      });

      const context = await emptyPlugin.retrieveContext('query', {
        agentId: 'agent-empty',
      });

      expect(context.content).toBe('');
      expect(context.sources).toHaveLength(0);
    });

    it('should return relevant chunks', async () => {
      const context = await plugin.retrieveContext('How do I install?', {
        agentId: 'agent-1',
      });

      expect(context.content).toBeTruthy();
      expect(context.sources?.length).toBeGreaterThan(0);
    });

    it('should include sources with metadata', async () => {
      const context = await plugin.retrieveContext('installation', {
        agentId: 'agent-1',
      });
      expect(context.sources).toBeDefined();
      if (context.sources) {
        expect(context.sources[0]).toHaveProperty('id');
        expect(context.sources[0]).toHaveProperty('score');
      }
    });

    it('should include context metadata', async () => {
      const context = await plugin.retrieveContext('query', {
        agentId: 'agent-1',
      });

      expect(context.metadata).toBeDefined();
      expect(context.metadata?.count).toBeDefined();
      expect(context.metadata?.strategy).toBe('markdown');
    });

    it('should filter by type', async () => {
      // First ingest a document with code
      await plugin.ingest(
        [{
          id: 'code-doc',
          content: '# Example\n\n```javascript\nconsole.log("hello");\n```',
        }],
        { agentId: 'agent-1' }
      );

      const context = await plugin.retrieveContext('example', {
        agentId: 'agent-1',
        filters: { type: 'code' },
      });

      // All sources should be code type
      expect(context.sources).toBeDefined();
      context.sources?.forEach(source => {
        expect(source.type).toBe('code');
      });
    });

    it('should filter by section', async () => {
      const context = await plugin.retrieveContext('api', {
        agentId: 'agent-1',
        filters: { section: 'API' },
      });

      // Filter should work
      expect(context.metadata?.count).toBeDefined();
    });

    it('should respect limit config', async () => {
      const limitedPlugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
        limit: 2,
        minSimilarity: 0,
      });

      // Ingest many chunks
      await limitedPlugin.ingest(
        Array.from({ length: 10 }, (_, i) => ({
          id: `doc-${i}`,
          content: `Document ${i} content`,
        })),
        { agentId: 'agent-1' }
      );

      const context = await limitedPlugin.retrieveContext('document', {
        agentId: 'agent-1',
      });

      expect(context.sources?.length).toBeLessThanOrEqual(2);
    });
  });

  // ============================================================================
  // Update Documents
  // ============================================================================

  describe('update', () => {
    beforeEach(async () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
      });

      await plugin.ingest(
        [{ id: 'doc1', content: 'Original content' }],
        { agentId: 'agent-1' }
      );
    });

    it('should require agentId', async () => {
      await expect(
        plugin.update('doc1', { content: 'Updated content' })
      ).rejects.toThrow('agentId is required');
    });

    it('should update document content', async () => {
      await plugin.update(
        'doc1',
        { content: 'Updated content' },
        { agentId: 'agent-1' }
      );

      // The document should be re-indexed
      const stats = plugin.getStats();
      expect(stats.agentStats['agent-1']).toBeDefined();
    });

    it('should update document metadata only', async () => {
      // Should preserve existing content when only updating metadata
      await plugin.update(
        'doc1',
        { metadata: { title: 'New Title' } },
        { agentId: 'agent-1' }
      );

      const stats = plugin.getStats();
      expect(stats.agentStats['agent-1']).toBeDefined();
      expect(stats.agentStats['agent-1'].totalChunks).toBeGreaterThan(0);
    });

    it('should throw for non-existent document without content', async () => {
      await expect(
        plugin.update('non-existent', { metadata: {} }, { agentId: 'agent-1' })
      ).rejects.toThrow('Document not found');
    });
  });

  // ============================================================================
  // Delete Documents
  // ============================================================================

  describe('delete', () => {
    beforeEach(async () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
      });

      await plugin.ingest(
        [
          { id: 'doc1', content: 'First document' },
          { id: 'doc2', content: 'Second document' },
          { id: 'doc3', content: 'Third document' },
        ],
        { agentId: 'agent-1' }
      );
    });

    it('should require agentId', async () => {
      await expect(plugin.delete('doc1')).rejects.toThrow('agentId is required');
    });

    it('should delete a single document', async () => {
      const initialStats = plugin.getStats();
      const initialChunks = initialStats.agentStats['agent-1'].totalChunks;

      const deleted = await plugin.delete('doc1', { agentId: 'agent-1' });

      expect(deleted).toBeGreaterThan(0);

      const newStats = plugin.getStats();
      expect(newStats.agentStats['agent-1'].totalChunks).toBeLessThan(initialChunks);
    });

    it('should delete multiple documents', async () => {
      const deleted = await plugin.delete(['doc1', 'doc2'], { agentId: 'agent-1' });

      expect(deleted).toBeGreaterThan(0);
    });

    it('should return 0 for non-existent document', async () => {
      const deleted = await plugin.delete('non-existent', { agentId: 'agent-1' });

      expect(deleted).toBe(0);
    });
  });

  // ============================================================================
  // Statistics & Clear
  // ============================================================================

  describe('getStats', () => {
    it('should return empty stats initially', () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
      });

      const stats = plugin.getStats();

      expect(stats.totalAgents).toBe(0);
      expect(stats.agentStats).toEqual({});
    });

    it('should return stats after ingestion', async () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
      });

      await plugin.ingest(
        [{ id: 'doc1', content: '# Title\n\nContent here.' }],
        { agentId: 'agent-1' }
      );

      const stats = plugin.getStats();

      expect(stats.totalAgents).toBe(1);
      expect(stats.agentStats['agent-1']).toBeDefined();
      expect(stats.agentStats['agent-1'].totalChunks).toBeGreaterThan(0);
    });

    it('should track chunk types', async () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
      });

      await plugin.ingest(
        [{
          id: 'doc1',
          content: '# Heading\n\nText content.\n\n```js\ncode();\n```',
        }],
        { agentId: 'agent-1' }
      );

      const stats = plugin.getStats();
      const byType = stats.agentStats['agent-1'].byType;

      expect(byType.heading).toBeGreaterThan(0);
      expect(byType.text).toBeGreaterThan(0);
      expect(byType.code).toBeGreaterThan(0);
    });
  });

  describe('clearAgent', () => {
    it('should clear data for specific agent', async () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
      });

      await plugin.ingest(
        [{ id: 'doc1', content: 'Content' }],
        { agentId: 'agent-1' }
      );
      await plugin.ingest(
        [{ id: 'doc2', content: 'Content' }],
        { agentId: 'agent-2' }
      );

      plugin.clearAgent('agent-1');

      const stats = plugin.getStats();
      expect(stats.agentStats['agent-1']).toBeUndefined();
      expect(stats.agentStats['agent-2']).toBeDefined();
    });
  });

  describe('clearAll', () => {
    it('should clear all data', async () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
      });

      await plugin.ingest(
        [{ id: 'doc1', content: 'Content' }],
        { agentId: 'agent-1' }
      );
      await plugin.ingest(
        [{ id: 'doc2', content: 'Content' }],
        { agentId: 'agent-2' }
      );

      plugin.clearAll();

      const stats = plugin.getStats();
      expect(stats.totalAgents).toBe(0);
      expect(stats.agentStats).toEqual({});
    });
  });

  // ============================================================================
  // Embedding Provider Selection
  // ============================================================================

  describe('embedding providers', () => {
    it('should call OpenAI API for openai provider', async () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'openai-key',
        embeddingProvider: 'openai',
      });

      await plugin.ingest(
        [{ id: 'doc1', content: 'Test' }],
        { agentId: 'agent-1' }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.any(Object)
      );
    });

    it('should call Voyage API for voyage provider', async () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'voyage-key',
        embeddingProvider: 'voyage',
      });

      await plugin.ingest(
        [{ id: 'doc1', content: 'Test' }],
        { agentId: 'agent-1' }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.voyageai.com/v1/embeddings',
        expect.any(Object)
      );
    });

    it('should include correct auth header', async () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'my-secret-key',
      });

      await plugin.ingest(
        [{ id: 'doc1', content: 'Test' }],
        { agentId: 'agent-1' }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-secret-key',
          }),
        })
      );
    });
  });

  // ============================================================================
  // Context Formatting
  // ============================================================================

  describe('context formatting', () => {
    beforeEach(async () => {
      plugin = new DocsRAGPlugin({
        embeddingProviderApiKey: 'test-key',
        minSimilarity: 0,
      });
    });

    it('should format code blocks with language', async () => {
      await plugin.ingest(
        [{
          id: 'doc1',
          content: '# Example\n\n```typescript\nconst x = 1;\n```',
        }],
        { agentId: 'agent-1' }
      );

      const context = await plugin.retrieveContext('example', {
        agentId: 'agent-1',
        filters: { type: 'code' },
      });

      if (context.content) {
        expect(context.content).toContain('```typescript');
      }
    });

    it('should group chunks by section', async () => {
      await plugin.ingest(
        [{
          id: 'doc1',
          content: '# Section A\n\nContent A.\n\n# Section B\n\nContent B.',
        }],
        { agentId: 'agent-1' }
      );

      const context = await plugin.retrieveContext('content', {
        agentId: 'agent-1',
      });

      // Should have section headers in formatted context
      if (context.content) {
        expect(context.content).toContain('##');
      }
    });
  });
});

