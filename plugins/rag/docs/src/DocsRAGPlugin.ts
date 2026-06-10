import type {
  RAGPlugin,
  RAGContext,
  RAGDocument,
  IngestResult,
  IngestOptions,
  IngestPlanInfo,
  IngestDocumentProgress,
  IngestProgressPhase,
} from '@snap-agent/core';
import { MongoClient, Db, Collection } from 'mongodb';
import OpenAI from 'openai';
import { runWithConcurrency } from './concurrency';

// ============================================================================
// Types
// ============================================================================

export type EmbeddingProvider = 'openai' | 'voyage';

export interface DocsRAGConfig {
  // MongoDB connection (required)
  mongoUri: string;
  dbName: string;
  collection?: string;  // Default: 'docs_content'

  // Tenant isolation (required)
  tenantId: string;

  /**
   * API key for embedding provider
   */
  embeddingProviderApiKey: string;

  /**
   * Embedding provider to use
   * - 'openai': OpenAI text-embedding models (default)
   * - 'voyage': Voyage AI models (better multilingual support)
   * @default 'openai'
   */
  embeddingProvider?: EmbeddingProvider;

  /**
   * Embedding model
   * @default 'text-embedding-3-small' for OpenAI, 'voyage-3-lite' for Voyage
   */
  embeddingModel?: string;

  // Vector Search configuration
  vectorIndexName?: string;  // Default: 'docs_vector_index'
  numCandidates?: number;    // Default: 100

  /**
   * Chunking strategy for documents
   * @default 'markdown'
   */
  chunkingStrategy?: ChunkingStrategy;

  /**
   * Maximum chunk size in characters
   * @default 1000
   */
  maxChunkSize?: number;

  /**
   * Overlap between chunks in characters
   * @default 200
   */
  chunkOverlap?: number;

  /**
   * Texts sent per embeddings request during ingestion
   * @default 100
   */
  embeddingBatchSize?: number;

  /**
   * Concurrent embedding requests during ingestion
   * @default 4
   */
  embeddingConcurrency?: number;

  /**
   * Number of results to return
   * @default 5
   */
  limit?: number;

  /**
   * Minimum similarity score (0-1)
   * @default 0.7
   */
  minSimilarity?: number;

  /**
   * Include code blocks in search
   * @default true
   */
  includeCode?: boolean;

  // Filterable metadata fields (for MongoDB index optimization)
  filterableFields?: string[];  // e.g., ['type', 'section', 'language']

  // Caching
  cache?: {
    embeddings?: {
      enabled: boolean;
      ttl?: number;      // Default: 3600000 (1 hour)
      maxSize?: number;  // Default: 1000
    };
  };

  // Plugin priority (higher = runs first)
  priority?: number;
}

export type ChunkingStrategy = 'paragraph' | 'sentence' | 'fixed' | 'markdown';

type PlannedDocChunk = {
  content: string;
  metadata: { type: 'text' | 'code' | 'heading'; section?: string; language?: string };
};

function buildIngestByDocumentSnapshot(
  plan: Array<{ documentId: string; chunkCount: number }>,
  activeDocId: string,
  activeDocChunksDone: number,
): Record<string, IngestDocumentProgress> {
  const activeIdx = plan.findIndex((d) => d.documentId === activeDocId);
  const result: Record<string, IngestDocumentProgress> = {};
  for (let idx = 0; idx < plan.length; idx++) {
    const p = plan[idx];
    let chunksDone: number;
    if (activeIdx < 0) {
      chunksDone = 0;
    } else if (idx < activeIdx) {
      chunksDone = p.chunkCount;
    } else if (idx === activeIdx) {
      chunksDone = activeDocChunksDone;
    } else {
      chunksDone = 0;
    }
    result[p.documentId] = { chunksDone, chunksTotal: p.chunkCount };
  }
  return result;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
  embedding: number[];
  metadata: {
    title?: string;
    section?: string;
    type: 'text' | 'code' | 'heading';
    language?: string;
    startLine?: number;
    endLine?: number;
    [key: string]: any;
  };
  createdAt: Date;
}

/**
 * Stored document chunk with tenant and agent isolation
 */
export interface StoredDocChunk extends DocumentChunk {
  chunkIndex: number;
  tenantId: string;
  agentId: string;  // 'shared' or specific agent ID
  updatedAt?: Date;
}

// ============================================================================
// Documentation RAG Plugin
// ============================================================================

/**
 * Documentation RAG Plugin
 * 
 * Optimized for technical documentation, markdown files, and code.
 * 
 * Features:
 * - Smart chunking strategies (paragraph, sentence, markdown-aware)
 * - Code block extraction and indexing
 * - Section hierarchy awareness
 * - Heading-based context
 * - MongoDB persistent storage with vector search
 * - Embedding caching for performance
 */
export class DocsRAGPlugin implements RAGPlugin {
  name = 'docs-rag';
  type = 'rag' as const;
  priority: number;

  private config: Omit<Required<DocsRAGConfig>, 'cache' | 'priority'> & Pick<DocsRAGConfig, 'cache' | 'priority'>;
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private openai: OpenAI;

  // Embedding cache
  private embeddingCache = new Map<string, { value: number[]; timestamp: number }>();
  private cacheStats = { hits: 0, misses: 0 };

  constructor(config: DocsRAGConfig) {
    // Validate required fields
    if (!config.mongoUri) {
      throw new Error('mongoUri is required for DocsRAGPlugin');
    }
    if (!config.dbName) {
      throw new Error('dbName is required for DocsRAGPlugin');
    }
    if (!config.tenantId) {
      throw new Error('tenantId is required for DocsRAGPlugin');
    }

    const provider = config.embeddingProvider || 'openai';

    // Set default model based on provider
    const defaultModel = provider === 'voyage'
      ? 'voyage-3-lite'
      : 'text-embedding-3-small';

    this.config = {
      mongoUri: config.mongoUri,
      dbName: config.dbName,
      collection: config.collection || 'docs_content',
      tenantId: config.tenantId,
      embeddingProviderApiKey: config.embeddingProviderApiKey,
      embeddingProvider: provider,
      embeddingModel: config.embeddingModel || defaultModel,
      vectorIndexName: config.vectorIndexName || 'docs_vector_index',
      numCandidates: config.numCandidates || 100,
      chunkingStrategy: config.chunkingStrategy || 'markdown',
      maxChunkSize: config.maxChunkSize || 1000,
      chunkOverlap: config.chunkOverlap || 200,
      embeddingBatchSize: config.embeddingBatchSize || 100,
      embeddingConcurrency: config.embeddingConcurrency || 4,
      limit: config.limit || 5,
      minSimilarity: config.minSimilarity || 0.7,
      includeCode: config.includeCode !== false,
      filterableFields: config.filterableFields || ['type', 'section'],
      cache: config.cache,
      priority: config.priority ?? 100,
    };

    this.priority = this.config.priority ?? 100;
    this.openai = new OpenAI({ apiKey: config.embeddingProviderApiKey });
  }

  // ============================================================================
  // MongoDB Connection
  // ============================================================================

  private async getCollection(): Promise<Collection<StoredDocChunk>> {
    if (!this.client) {
      this.client = new MongoClient(this.config.mongoUri);
      await this.client.connect();
      this.db = this.client.db(this.config.dbName);
      
      // Ensure indexes
      await this.ensureIndexes();
    }
    return this.db!.collection<StoredDocChunk>(this.config.collection);
  }

  private async ensureIndexes(): Promise<void> {
    const collection = this.db!.collection(this.config.collection);
    
    // Create compound indexes for efficient queries
    await collection.createIndex({ 
      tenantId: 1, 
      agentId: 1, 
      documentId: 1 
    });
    
    await collection.createIndex({ 
      tenantId: 1, 
      agentId: 1, 
      'metadata.type': 1 
    });

    await collection.createIndex({ 
      updatedAt: -1 
    });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }

  /**
   * Get cache statistics
   * @returns Cache hit/miss stats and configuration
   */
  getCacheStats() {
    return {
      enabled: this.config.cache?.embeddings?.enabled ?? false,
      hits: this.cacheStats.hits,
      misses: this.cacheStats.misses,
      size: this.embeddingCache.size,
      hitRate: this.cacheStats.hits + this.cacheStats.misses > 0
        ? this.cacheStats.hits / (this.cacheStats.hits + this.cacheStats.misses)
        : 0,
    };
  }

  // ============================================================================
  // RAG Plugin Interface
  // ============================================================================

  /**
   * Retrieve relevant documentation chunks for a query
   */
  async retrieveContext(
    message: string,
    options: {
      agentId?: string;
      threadId?: string;
      filters?: Record<string, any>;
      metadata?: Record<string, any>;
    } = {}
  ): Promise<RAGContext> {
    // Generate query embedding
    const queryVector = await this.generateEmbedding(message);

    // Build filter for vector search
    const hardFilters: Record<string, any> = {
      tenantId: this.config.tenantId,
      ...options.filters,
    };

    // Agent filtering: shared content (agentId: 'shared') + agent-specific
    if (options.agentId) {
      hardFilters.agentId = { $in: ['shared', options.agentId] };
    }

    // Perform vector search
    const results = await this.vectorSearch({
      queryVector,
      hardFilters,
    });

    if (results.length === 0) {
      return {
        content: '',
        sources: [],
        metadata: { count: 0, strategy: this.config.chunkingStrategy },
      };
    }

    // Format context with section headers
    const content = this.formatChunksToContext(results);

    return {
      content,
      sources: results.map((chunk) => ({
        id: chunk.id,
        documentId: chunk.documentId,
        score: chunk.score,
        metadata: chunk.metadata,
      })),
      metadata: {
        count: results.length,
        strategy: this.config.chunkingStrategy,
        avgScore: results.length > 0
          ? results.reduce((sum, c) => sum + c.score, 0) / results.length
          : 0,
      },
    };
  }

  /**
   * Vector search using MongoDB Atlas Search
   */
  private async vectorSearch(options: {
    queryVector: number[];
    hardFilters: Record<string, any>;
  }): Promise<Array<StoredDocChunk & { score: number }>> {
    const collection = await this.getCollection();

    const pipeline: any[] = [
      {
        $vectorSearch: {
          index: this.config.vectorIndexName,
          path: 'embedding',
          queryVector: options.queryVector,
          numCandidates: this.config.numCandidates,
          limit: this.config.limit * 2,  // Fetch more for post-filtering
          filter: options.hardFilters,
        },
      },
      {
        $addFields: {
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ];

    // Apply minimum score filter
    if (this.config.minSimilarity) {
      pipeline.push({
        $match: { score: { $gte: this.config.minSimilarity } },
      });
    }

    pipeline.push({ $limit: this.config.limit });

    const results = await collection.aggregate(pipeline).toArray();

    return results as Array<StoredDocChunk & { score: number }>;
  }

  /**
   * Format retrieved chunks into context string
   */
  private formatChunksToContext(chunks: Array<DocumentChunk & { score: number }>): string {
    if (chunks.length === 0) return '';

    const sections: string[] = [];
    let currentSection = '';

    for (const chunk of chunks) {
      // Add section header if different
      const section = chunk.metadata.section || 'General';
      if (section !== currentSection) {
        currentSection = section;
        sections.push(`\n## ${section}\n`);
      }

      // Format based on type
      if (chunk.metadata.type === 'code') {
        const lang = chunk.metadata.language || '';
        sections.push(`\`\`\`${lang}\n${chunk.content}\n\`\`\``);
      } else {
        sections.push(chunk.content);
      }
    }

    return sections.join('\n\n');
  }

  /**
   * Ingest documents with intelligent chunking
   */
  async ingest(
    documents: RAGDocument[],
    options?: IngestOptions
  ): Promise<IngestResult> {
    if (!options?.agentId) {
      return {
        success: false,
        indexed: 0,
        failed: documents.length,
        errors: [{ id: 'batch', error: 'agentId is required' }],
      };
    }

    const collection = await this.getCollection();
    const errors: Array<{ id: string; error: string }> = [];
    // Captured after the guard above so it stays narrowed to `string` inside
    // the bulkWrite map closure (TS widens options.agentId back to string|undefined there).
    const agentId = options.agentId;

    const planned: Array<{ doc: RAGDocument; chunks: PlannedDocChunk[] }> = [];
    for (const doc of documents) {
      try {
        const chunks = this.chunkDocument(doc);
        planned.push({ doc, chunks });
      } catch (error) {
        errors.push({
          id: doc.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const planDocumentsMeta = planned.map(({ doc, chunks }) => ({
      documentId: doc.id,
      chunkCount: chunks.length,
    }));
    const totalChunks = planDocumentsMeta.reduce((sum, row) => sum + row.chunkCount, 0);

    if (options.onIngestPlan) {
      const plan: IngestPlanInfo = {
        totalChunks,
        documents: planDocumentsMeta,
      };
      await options.onIngestPlan(plan);
    }

    let indexed = 0;
    let processedGlobal = 0;

    // Flatten every chunk across all documents so they can be processed in
    // batched, concurrent macro-batches (instead of one request + one write per
    // chunk). Each macro-batch EMBEDS and PERSISTS before moving on, so progress
    // is reported incrementally throughout the run (not only at the very end).
    type FlatChunk = { doc: RAGDocument; chunkIndex: number; chunk: PlannedDocChunk };
    const flat: FlatChunk[] = [];
    const chunkCountByDoc = new Map<string, number>();
    for (const { doc, chunks } of planned) {
      chunkCountByDoc.set(doc.id, chunks.length);
      for (let i = 0; i < chunks.length; i++) {
        flat.push({ doc, chunkIndex: i, chunk: chunks[i] });
      }
    }

    // Notify the embedding phase once before processing starts.
    if (options.onIngestProgress && planned.length > 0) {
      const first = planned[0];
      await options.onIngestProgress({
        phase: 'embedding' as IngestProgressPhase,
        documentId: first.doc.id,
        chunkIndex: 0,
        chunksInDocument: first.chunks.length,
        processedGlobal,
        totalGlobal: totalChunks,
        byDocument: buildIngestByDocumentSnapshot(planDocumentsMeta, first.doc.id, 0),
      });
    }

    const failedDocIds = new Set<string>();
    const remainingByDoc = new Map<string, number>(chunkCountByDoc);
    const markFailed = (docId: string, error: unknown) => {
      if (failedDocIds.has(docId)) return;
      failedDocIds.add(docId);
      errors.push({
        id: docId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    };

    // One macro-batch ≈ one full concurrency wave of embedding sub-batches.
    const macroSize = Math.max(
      1,
      (this.config.embeddingBatchSize ?? 100) * (this.config.embeddingConcurrency ?? 4)
    );

    for (let start = 0; start < flat.length; start += macroSize) {
      const slice = flat
        .slice(start, start + macroSize)
        .filter((f) => !failedDocIds.has(f.doc.id));
      if (slice.length === 0) continue;

      // Embed this macro-batch (internally split into concurrent sub-batches).
      let embeddings: number[][];
      try {
        embeddings = await this.generateEmbeddingsBatch(slice.map((f) => f.chunk.content));
      } catch (error) {
        for (const f of slice) markFailed(f.doc.id, error);
        continue;
      }

      // Persist this macro-batch with a single bulkWrite.
      const ops = slice.map((f, i) => {
        const id = `chunk-${f.doc.id}-${f.chunkIndex}`;
        const storedChunk: Omit<StoredDocChunk, 'createdAt' | 'updatedAt'> = {
          id,
          documentId: f.doc.id,
          chunkIndex: f.chunkIndex,
          content: f.chunk.content,
          embedding: embeddings[i],
          metadata: {
            ...f.doc.metadata,
            ...f.chunk.metadata,
          },
          tenantId: this.config.tenantId,
          agentId,
        };

        return {
          updateOne: {
            filter: { tenantId: this.config.tenantId, agentId, id },
            update: {
              $set: { ...storedChunk, updatedAt: new Date() },
              $setOnInsert: { createdAt: new Date() },
            },
            upsert: true,
          },
        };
      });

      try {
        await collection.bulkWrite(ops as any);
      } catch (error) {
        for (const f of slice) markFailed(f.doc.id, error);
        continue;
      }

      processedGlobal += slice.length;

      // A document counts as indexed once all of its chunks are written.
      for (const f of slice) {
        const remaining = (remainingByDoc.get(f.doc.id) ?? 0) - 1;
        remainingByDoc.set(f.doc.id, remaining);
        if (remaining === 0) indexed++;
      }

      // Emit incremental 'stored' progress for this macro-batch.
      if (options.onIngestProgress) {
        const last = slice[slice.length - 1];
        await options.onIngestProgress({
          phase: 'stored' as IngestProgressPhase,
          documentId: last.doc.id,
          chunkIndex: last.chunkIndex,
          chunksInDocument: chunkCountByDoc.get(last.doc.id) ?? last.chunkIndex + 1,
          processedGlobal,
          totalGlobal: totalChunks,
          byDocument: buildIngestByDocumentSnapshot(
            planDocumentsMeta,
            last.doc.id,
            last.chunkIndex + 1
          ),
        });
      }
    }

    return {
      success: errors.length === 0,
      indexed,
      failed: errors.length,
      errors: errors.length > 0 ? errors : undefined,
      metadata: {
        strategy: this.config.chunkingStrategy,
        totalChunks,
      },
    };
  }

  /**
   * Chunk a document based on configured strategy
   */
  private chunkDocument(doc: RAGDocument): Array<{
    content: string;
    metadata: { type: 'text' | 'code' | 'heading'; section?: string; language?: string };
  }> {
    const content = doc.content;
    const chunks: Array<{
      content: string;
      metadata: { type: 'text' | 'code' | 'heading'; section?: string; language?: string };
    }> = [];

    switch (this.config.chunkingStrategy) {
      case 'markdown':
        return this.chunkMarkdown(content, doc.metadata?.title);
      case 'paragraph':
        return this.chunkByParagraph(content);
      case 'sentence':
        return this.chunkBySentence(content);
      case 'fixed':
        return this.chunkFixed(content);
      default:
        return this.chunkByParagraph(content);
    }
  }

  /**
   * Markdown-aware chunking
   */
  private chunkMarkdown(content: string, docTitle?: string): Array<{
    content: string;
    metadata: { type: 'text' | 'code' | 'heading'; section?: string; language?: string };
  }> {
    const chunks: Array<{
      content: string;
      metadata: { type: 'text' | 'code' | 'heading'; section?: string; language?: string };
    }> = [];

    let currentSection = docTitle || 'Overview';
    const lines = content.split('\n');
    let currentChunk = '';
    let inCodeBlock = false;
    let codeLanguage = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check for code block
      if (line.startsWith('```')) {
        if (!inCodeBlock) {
          // Starting code block
          if (currentChunk.trim()) {
            chunks.push({
              content: currentChunk.trim(),
              metadata: { type: 'text', section: currentSection },
            });
            currentChunk = '';
          }
          inCodeBlock = true;
          codeLanguage = line.slice(3).trim();
        } else {
          // Ending code block
          if (this.config.includeCode && currentChunk.trim()) {
            chunks.push({
              content: currentChunk.trim(),
              metadata: { type: 'code', section: currentSection, language: codeLanguage },
            });
          }
          currentChunk = '';
          inCodeBlock = false;
          codeLanguage = '';
        }
        continue;
      }

      // Check for record separator (---) — flush without including the separator
      if (/^-{3,}$/.test(line.trim()) && !inCodeBlock) {
        if (currentChunk.trim()) {
          chunks.push({
            content: currentChunk.trim(),
            metadata: { type: 'text', section: currentSection },
          });
          currentChunk = '';
        }
        continue;
      }

      // Check for headings
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch && !inCodeBlock) {
        // Save current chunk
        if (currentChunk.trim()) {
          chunks.push({
            content: currentChunk.trim(),
            metadata: { type: 'text', section: currentSection },
          });
          currentChunk = '';
        }

        // Update section
        currentSection = headingMatch[2];

        // Add heading as its own chunk for searchability
        chunks.push({
          content: headingMatch[2],
          metadata: { type: 'heading', section: currentSection },
        });
        continue;
      }

      // Add line to current chunk
      currentChunk += line + '\n';

      // Check if chunk is too large
      if (currentChunk.length > this.config.maxChunkSize && !inCodeBlock) {
        chunks.push({
          content: currentChunk.trim(),
          metadata: { type: 'text', section: currentSection },
        });
        currentChunk = '';
      }
    }

    // Don't forget the last chunk
    if (currentChunk.trim()) {
      chunks.push({
        content: currentChunk.trim(),
        metadata: { type: inCodeBlock ? 'code' : 'text', section: currentSection },
      });
    }

    return chunks;
  }

  /**
   * Split plain text that exceeds max chunk size (used when PDFs have no `\n\n`
   * breaks or a single "paragraph" is huge).
   */
  private splitTextByMaxChunkSize(text: string): string[] {
    const size = this.config.maxChunkSize;
    const overlap = this.config.chunkOverlap;
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += size - overlap) {
      const slice = text.slice(i, i + size);
      if (slice.trim()) {
        parts.push(slice.trim());
      }
    }
    return parts.length > 0 ? parts : (text.trim() ? [text.trim()] : []);
  }

  /**
   * Paragraph-based chunking
   */
  private chunkByParagraph(content: string): Array<{
    content: string;
    metadata: { type: 'text' | 'code' | 'heading'; section?: string };
  }> {
    const paragraphs = content.split(/\n\n+/);
    const chunks: Array<{
      content: string;
      metadata: { type: 'text' | 'code' | 'heading'; section?: string };
    }> = [];

    let currentChunk = '';

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) {
        continue;
      }

      const pieces =
        trimmed.length <= this.config.maxChunkSize
          ? [trimmed]
          : this.splitTextByMaxChunkSize(trimmed);

      for (const piece of pieces) {
        if ((currentChunk + (currentChunk ? '\n\n' : '') + piece).length > this.config.maxChunkSize) {
          if (currentChunk.trim()) {
            chunks.push({
              content: currentChunk.trim(),
              metadata: { type: 'text' },
            });
          }
          currentChunk = piece;
        } else {
          currentChunk += (currentChunk ? '\n\n' : '') + piece;
        }
      }
    }

    if (currentChunk.trim()) {
      chunks.push({
        content: currentChunk.trim(),
        metadata: { type: 'text' },
      });
    }

    return chunks;
  }

  /**
   * Sentence-based chunking
   */
  private chunkBySentence(content: string): Array<{
    content: string;
    metadata: { type: 'text' | 'code' | 'heading'; section?: string };
  }> {
    const sentences = content.split(/(?<=[.!?])\s+/);
    const chunks: Array<{
      content: string;
      metadata: { type: 'text' | 'code' | 'heading'; section?: string };
    }> = [];

    let currentChunk = '';

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) {
        continue;
      }

      const pieces =
        trimmed.length <= this.config.maxChunkSize
          ? [trimmed]
          : this.splitTextByMaxChunkSize(trimmed);

      for (const piece of pieces) {
        if ((currentChunk + (currentChunk ? ' ' : '') + piece).length > this.config.maxChunkSize) {
          if (currentChunk.trim()) {
            chunks.push({
              content: currentChunk.trim(),
              metadata: { type: 'text' },
            });
          }
          currentChunk = piece;
        } else {
          currentChunk += (currentChunk ? ' ' : '') + piece;
        }
      }
    }

    if (currentChunk.trim()) {
      chunks.push({
        content: currentChunk.trim(),
        metadata: { type: 'text' },
      });
    }

    return chunks;
  }

  /**
   * Fixed-size chunking with overlap
   */
  private chunkFixed(content: string): Array<{
    content: string;
    metadata: { type: 'text' | 'code' | 'heading'; section?: string };
  }> {
    const chunks: Array<{
      content: string;
      metadata: { type: 'text' | 'code' | 'heading'; section?: string };
    }> = [];

    const size = this.config.maxChunkSize;
    const overlap = this.config.chunkOverlap;

    for (let i = 0; i < content.length; i += size - overlap) {
      const chunk = content.slice(i, i + size);
      if (chunk.trim()) {
        chunks.push({
          content: chunk.trim(),
          metadata: { type: 'text' },
        });
      }
    }

    return chunks;
  }

  /**
   * Update a document (re-chunks and re-embeds)
   */
  async update(
    id: string,
    document: Partial<RAGDocument>,
    options?: IngestOptions
  ): Promise<void> {
    if (!options?.agentId) {
      throw new Error('agentId is required');
    }

    if (!document.content) {
      throw new Error('document.content is required for update');
    }

    // Remove existing chunks for this document
    await this.delete(id, options);

    // Re-ingest with updated content
    const updatedDoc: RAGDocument = {
      id,
      content: document.content,
      metadata: document.metadata || {},
    };

    await this.ingest([updatedDoc], options);
  }

  /**
   * Delete document and its chunks
   */
  async delete(ids: string | string[], options?: IngestOptions): Promise<number> {
    if (!options?.agentId) {
      throw new Error('agentId is required');
    }

    const idsArray = Array.isArray(ids) ? ids : [ids];
    const collection = await this.getCollection();

    const result = await collection.deleteMany({
      tenantId: this.config.tenantId,
      agentId: options.agentId,
      documentId: { $in: idsArray },
    });

    return result.deletedCount;
  }

  // ============================================================================
  // Embedding Generation
  // ============================================================================

  /**
   * Generate embedding using configured provider (OpenAI or Voyage)
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    const cacheConfig = this.config.cache?.embeddings;

    // Check cache
    if (cacheConfig?.enabled) {
      const cached = this.embeddingCache.get(text);
      const ttl = cacheConfig.ttl ?? 3600000;
      if (cached && Date.now() - cached.timestamp < ttl) {
        this.cacheStats.hits++;
        return cached.value;
      }
    }

    this.cacheStats.misses++;

    // Generate embedding based on provider
    let embedding: number[];
    if (this.config.embeddingProvider === 'voyage') {
      embedding = await this.generateVoyageEmbedding(text);
    } else {
      embedding = await this.generateOpenAIEmbedding(text);
    }

    // Cache result
    this.storeEmbeddingInCache(text, embedding);

    return embedding;
  }

  /** Store an embedding in the LRU-ish in-memory cache (no-op if caching disabled). */
  private storeEmbeddingInCache(text: string, embedding: number[]): void {
    const cacheConfig = this.config.cache?.embeddings;
    if (!cacheConfig?.enabled) return;
    const maxSize = cacheConfig.maxSize ?? 1000;
    if (this.embeddingCache.size >= maxSize) {
      // Remove oldest entry
      const firstKey = this.embeddingCache.keys().next().value;
      if (firstKey) this.embeddingCache.delete(firstKey);
    }
    this.embeddingCache.set(text, { value: embedding, timestamp: Date.now() });
  }

  /**
   * Embed many texts using true API batching + bounded concurrency.
   * Sends arrays of up to `embeddingBatchSize` texts per request and runs
   * up to `embeddingConcurrency` requests in parallel. Cache hits are resolved
   * up front and duplicate texts are embedded only once.
   * Returns embeddings aligned 1:1 with the input order.
   */
  private async generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
    const results = new Array<number[]>(texts.length);
    const cacheConfig = this.config.cache?.embeddings;
    const ttl = cacheConfig?.ttl ?? 3600000;

    // Resolve cache hits; group remaining misses by unique text.
    const missTextToIndices = new Map<string, number[]>();
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (cacheConfig?.enabled) {
        const cached = this.embeddingCache.get(text);
        if (cached && Date.now() - cached.timestamp < ttl) {
          this.cacheStats.hits++;
          results[i] = cached.value;
          continue;
        }
      }
      this.cacheStats.misses++;
      const existing = missTextToIndices.get(text);
      if (existing) existing.push(i);
      else missTextToIndices.set(text, [i]);
    }

    const missTexts = [...missTextToIndices.keys()];
    if (missTexts.length === 0) return results;

    const batchSize = Math.max(1, this.config.embeddingBatchSize ?? 100);
    const concurrency = Math.max(1, this.config.embeddingConcurrency ?? 4);

    const subBatches: string[][] = [];
    for (let i = 0; i < missTexts.length; i += batchSize) {
      subBatches.push(missTexts.slice(i, i + batchSize));
    }

    const jobs = subBatches.map((batch) => () => this.generateEmbeddingsForBatch(batch));
    const batchResults = await runWithConcurrency(jobs, concurrency);

    for (let b = 0; b < subBatches.length; b++) {
      const batch = subBatches[b];
      const embeddings = batchResults[b];
      for (let j = 0; j < batch.length; j++) {
        const text = batch[j];
        const embedding = embeddings[j];
        for (const idx of missTextToIndices.get(text)!) {
          results[idx] = embedding;
        }
        this.storeEmbeddingInCache(text, embedding);
      }
    }

    return results;
  }

  /** Embed a single sub-batch with the configured provider. */
  private async generateEmbeddingsForBatch(texts: string[]): Promise<number[][]> {
    if (this.config.embeddingProvider === 'voyage') {
      return this.generateVoyageEmbeddings(texts);
    }
    return this.generateOpenAIEmbeddings(texts);
  }

  /**
   * Generate embedding using OpenAI
   */
  private async generateOpenAIEmbedding(text: string): Promise<number[]> {
    const [embedding] = await this.generateOpenAIEmbeddings([text]);
    return embedding;
  }

  /** Generate embeddings for an array of texts using OpenAI (single request). */
  private async generateOpenAIEmbeddings(texts: string[]): Promise<number[][]> {
    const response = await this.openai.embeddings.create({
      model: this.config.embeddingModel,
      input: texts,
    });

    // OpenAI returns one item per input; sort by index to be safe.
    return [...response.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  /**
   * Generate embedding using Voyage AI
   */
  private async generateVoyageEmbedding(text: string): Promise<number[]> {
    const [embedding] = await this.generateVoyageEmbeddings([text]);
    return embedding;
  }

  /**
   * Generate embeddings for an array of texts using Voyage AI (single request).
   * Voyage is called via raw fetch (no built-in retries), so we retry a few
   * times on rate-limit / transient server errors with exponential backoff.
   */
  private async generateVoyageEmbeddings(texts: string[]): Promise<number[][]> {
    const maxRetries = 3;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.embeddingProviderApiKey}`,
        },
        body: JSON.stringify({
          model: this.config.embeddingModel,
          input: texts,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          data: Array<{ embedding: number[]; index: number }>;
        };
        return [...data.data]
          .sort((a, b) => a.index - b.index)
          .map((d) => d.embedding);
      }

      const error = await response.text();
      lastError = new Error(`Voyage API error: ${response.status} - ${error}`);

      // Retry only on rate-limit / transient server errors.
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxRetries) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }

    throw lastError;
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get statistics about indexed documents
   */
  async getStats(): Promise<Record<string, any>> {
    const collection = await this.getCollection();
    
    // Get total count by tenant
    const totalChunks = await collection.countDocuments({
      tenantId: this.config.tenantId,
    });

    // Get count by agent
    const agentCounts = await collection.aggregate([
      { $match: { tenantId: this.config.tenantId } },
      { 
        $group: { 
          _id: '$agentId',
          count: { $sum: 1 },
          types: { $addToSet: '$metadata.type' },
        } 
      },
    ]).toArray();

    const agentStats: Record<string, any> = {};
    for (const agent of agentCounts) {
      agentStats[agent._id] = {
        totalChunks: agent.count,
        types: agent.types,
      };
    }

    return {
      tenantId: this.config.tenantId,
      totalChunks,
      strategy: this.config.chunkingStrategy,
      agentStats,
      cacheStats: this.cacheStats,
    };
  }

  /**
   * Clear embedding cache
   */
  clearCache(): void {
    this.embeddingCache.clear();
    this.cacheStats = { hits: 0, misses: 0 };
  }

  /**
   * Clear all data for an agent
   */
  async clearAgent(agentId: string): Promise<number> {
    const collection = await this.getCollection();
    
    const result = await collection.deleteMany({
      tenantId: this.config.tenantId,
      agentId,
    });

    return result.deletedCount;
  }

  /**
   * Clear all data for the tenant
   */
  async clearAll(): Promise<number> {
    const collection = await this.getCollection();
    
    const result = await collection.deleteMany({
      tenantId: this.config.tenantId,
    });

    return result.deletedCount;
  }

  /**
   * Get plugin configuration (for persistence)
   * Returns serializable config with env var references for sensitive data
   */
  getConfig(): Record<string, any> {
    return {
      mongoUri: '${MONGODB_URI}',
      dbName: this.config.dbName,
      collection: this.config.collection,
      tenantId: this.config.tenantId,
      embeddingProviderApiKey: '${OPENAI_API_KEY}',
      embeddingProvider: this.config.embeddingProvider,
      embeddingModel: this.config.embeddingModel,
      vectorIndexName: this.config.vectorIndexName,
      numCandidates: this.config.numCandidates,
      chunkingStrategy: this.config.chunkingStrategy,
      maxChunkSize: this.config.maxChunkSize,
      chunkOverlap: this.config.chunkOverlap,
      limit: this.config.limit,
      minSimilarity: this.config.minSimilarity,
      includeCode: this.config.includeCode,
      filterableFields: this.config.filterableFields,
      cache: this.config.cache,
      priority: this.priority,
    };
  }
}

