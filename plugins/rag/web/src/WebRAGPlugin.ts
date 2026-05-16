/**
 * Web RAG Plugin
 * 
 * Schema-agnostic RAG plugin for web content.
 * Works with Drupal, WordPress, Contentful, or any content source.
 * 
 * Key features:
 * - Flexible metadata: Only id, content, and type are required
 * - Pass-through fields: Store any metadata, get it back in results
 * - URL ingestion: Fetch from JSON, CSV, XML APIs
 * - Drupal helpers: JSON:API parsing and field mapping
 * - Type/recency boosts: Prioritize certain content types or fresh content
 */

import type {
  RAGPlugin,
  RAGContext,
  RAGDocument,
  IngestResult,
  IngestOptions,
  BulkOperation,
  BulkResult,
} from '@snap-agent/core';
import { MongoClient, Db, Collection } from 'mongodb';
import OpenAI from 'openai';
import * as cheerio from 'cheerio';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  WebRAGConfig,
  WebDocument,
  StoredWebDocument,
  URLSource,
  WebIngestResult,
  WebURLIngestResult,
  DrupalConfig,
  WordPressConfig,
  SanityConfig,
  StrapiConfig,
  SitemapConfig,
  UrlListConfig,
  SinglePageConfig,
  WebsiteCrawlConfig,
  RenderOptions,
  DebugOptions,
  CrawlLedgerDocument,
  CrawlLedgerStatus,
  CrawlPageStatusEntry,
  RSSConfig,
  CrawlResult,
} from './types';

// ============================================================================
// Web RAG Plugin
// ============================================================================

export class WebRAGPlugin implements RAGPlugin {
  name = 'web-rag';
  type = 'rag' as const;
  priority: number;

  private config: WebRAGConfig;
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private openai: OpenAI;

  // Embedding cache
  private embeddingCache = new Map<string, { value: number[]; timestamp: number }>();
  private cacheStats = { hits: 0, misses: 0 };

  constructor(config: WebRAGConfig) {
    this.config = {
      collection: 'web_content',
      embeddingModel: 'text-embedding-3-small',
      vectorIndexName: 'web_vector_index',
      numCandidates: 100,
      limit: 10,
      minScore: 0.7,
      filterableFields: ['type'],
      maxChunkSize: 1500,
      chunkOverlap: 200,
      ...config,
    };
    this.priority = config.priority ?? 100;
    this.openai = new OpenAI({ apiKey: config.openaiApiKey });
  }

  // ============================================================================
  // MongoDB Connection
  // ============================================================================

  private async getCollection(): Promise<Collection<StoredWebDocument>> {
    if (!this.client) {
      this.client = new MongoClient(this.config.mongoUri);
      await this.client.connect();
      this.db = this.client.db(this.config.dbName);
    }
    return this.db!.collection<StoredWebDocument>(this.config.collection!);
  }

  private async getLedgerCollection(): Promise<Collection<CrawlLedgerDocument>> {
    if (!this.client) {
      this.client = new MongoClient(this.config.mongoUri);
      await this.client.connect();
      this.db = this.client.db(this.config.dbName);
    }
    const name = this.config.crawlLedger?.collection ?? 'web_crawl_ledger';
    return this.db!.collection<CrawlLedgerDocument>(name);
  }

  /**
   * List recent crawl ledger rows (for dashboards / pagination in the front).
   */
  async listCrawlLedger(options: {
    agentId?: string;
    domain?: string;
    status?: CrawlLedgerStatus;
    limit?: number;
    skip?: number;
  } = {}): Promise<CrawlLedgerDocument[]> {
    const col = await this.getLedgerCollection();
    const filter: Record<string, unknown> = { tenantId: this.config.tenantId };
    filter.agentId = options.agentId ?? 'shared';
    if (options.domain) filter.domain = options.domain;
    if (options.status) filter.lastStatus = options.status;
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const skip = Math.max(options.skip ?? 0, 0);
    return col.find(filter).sort({ lastCrawledAt: -1 }).skip(skip).limit(limit).toArray();
  }

  private resolveCrawlLedgerOptions(
    config: SitemapConfig & { defaultType?: string }
  ): {
    ttlMsIndexed: number;
    ttlMsFailure: number;
    ttlMsRenderError: number;
    maxPageStatuses: number;
    stripQuery: boolean;
  } | null {
    const plugin = this.config.crawlLedger;
    const per = config.crawlLedger;
    const enabled = per?.enabled ?? plugin?.enabled ?? false;
    if (!enabled) return null;
    const ttlMsFailure = per?.ttlMsFailure ?? plugin?.ttlMsFailure ?? 60 * 60 * 1000;
    return {
      ttlMsIndexed: per?.ttlMsIndexed ?? plugin?.ttlMsIndexed ?? 7 * 24 * 60 * 60 * 1000,
      ttlMsFailure,
      ttlMsRenderError: per?.ttlMsRenderError ?? plugin?.ttlMsRenderError ?? 5 * 60 * 1000,
      maxPageStatuses: per?.maxPageStatuses ?? 500,
      stripQuery: config.stripQueryParams ?? false,
    };
  }

  private normalizeLedgerUrl(url: string, stripQuery: boolean): string | null {
    return this.normalizeWebsiteUrl(url, stripQuery);
  }

  private shouldSkipLedger(
    entry: CrawlLedgerDocument | null | undefined,
    ttlMsIndexed: number,
    ttlMsFailure: number,
    ttlMsRenderError: number,
    forceRecrawl: boolean
  ): boolean {
    if (forceRecrawl || !entry) return false;
    const t = entry.lastCrawledAt instanceof Date
      ? entry.lastCrawledAt.getTime()
      : new Date(entry.lastCrawledAt as unknown as string).getTime();
    const age = Date.now() - t;
    if (entry.lastStatus === 'indexed' && age < ttlMsIndexed) return true;
    if (entry.lastStatus === 'error' && age < ttlMsRenderError) return true;
    if (entry.lastStatus !== 'indexed' && entry.lastStatus !== 'error' && age < ttlMsFailure) {
      return true;
    }
    return false;
  }

  private async findLedgerEntry(
    urlNormalized: string,
    agentId: string
  ): Promise<CrawlLedgerDocument | null> {
    const col = await this.getLedgerCollection();
    return col.findOne({
      tenantId: this.config.tenantId,
      agentId,
      urlNormalized,
    });
  }

  private toLedgerStatus(
    doc: RAGDocument | null,
    diag?: { modeUsed?: string; reason?: string }
  ): CrawlLedgerStatus {
    if (doc) return 'indexed';
    if (diag?.reason === 'non_html') return 'non_html';
    if (diag?.reason === 'blocked_suspected') return 'blocked_suspected';
    if (diag?.reason === 'render_error') return 'error';
    return 'too_small';
  }

  private async upsertLedgerRecord(params: {
    url: string;
    urlNormalized: string;
    agentId: string;
    status: CrawlLedgerStatus;
    doc?: RAGDocument | null;
    diag?: { modeUsed?: string; reason?: string; errorMessage?: string };
    errorMessage?: string;
  }): Promise<void> {
    const col = await this.getLedgerCollection();
    let domain = '';
    try {
      domain = new URL(params.url).hostname;
    } catch {
      domain = '';
    }
    const now = new Date();
    const errMsg = params.errorMessage ?? params.diag?.errorMessage;
    const $set: Record<string, unknown> = {
      tenantId: this.config.tenantId,
      agentId: params.agentId,
      urlNormalized: params.urlNormalized,
      url: params.url,
      domain,
      lastStatus: params.status,
      lastCrawledAt: now,
      updatedAt: now,
    };
    if (errMsg !== undefined) {
      $set.errorMessage = errMsg;
    } else if (params.status === 'indexed' && params.doc) {
      $set.errorMessage = null;
    }
    if (params.doc) {
      $set.modeUsed = params.diag?.modeUsed;
      $set.contentLength = params.doc.content.length;
      $set.title = params.doc.metadata?.title;
      $set.docId = params.doc.id;
    } else {
      $set.modeUsed = params.diag?.modeUsed;
      $set.contentLength = null;
      $set.title = null;
      $set.docId = null;
    }
    await col.updateOne(
      {
        tenantId: this.config.tenantId,
        agentId: params.agentId,
        urlNormalized: params.urlNormalized,
      },
      { $set },
      { upsert: true }
    );
  }

  private pushPageStatus(
    list: CrawlPageStatusEntry[],
    max: number,
    entry: CrawlPageStatusEntry
  ): void {
    list.push(entry);
    while (list.length > max) list.shift();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }

  // ============================================================================
  // RAG Plugin Interface
  // ============================================================================

  /**
   * Retrieve contextual content for a message
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
    const queryVector = await this.generateEmbedding(message);

    // Build filter for vector search
    const hardFilters: Record<string, any> = {
      tenantId: this.config.tenantId,
      ...options.filters,
    };

    // Agent filtering: shared content (agentId: 'shared') + agent-specific
    // Using $in instead of $or (Atlas Vector Search doesn't support $or)
    if (options.agentId) {
      hardFilters.agentId = { $in: ['shared', options.agentId] };
    }

    const results = await this.vectorSearch({
      queryVector,
      hardFilters,
    });

    // Apply type boosts if configured
    let scoredResults = results;
    if (this.config.typeBoosts) {
      scoredResults = results.map(doc => ({
        ...doc,
        score: doc.score * (this.config.typeBoosts![doc.metadata.type] ?? 1),
      }));
    }

    // Apply recency boost if configured
    if (this.config.recencyBoost?.enabled) {
      const { field, decayDays, maxBoost = 1.2 } = this.config.recencyBoost;
      const now = Date.now();
      const decayMs = decayDays * 24 * 60 * 60 * 1000;

      scoredResults = scoredResults.map(doc => {
        const dateValue = doc.metadata[field];
        if (!dateValue) return doc;

        const docDate = new Date(dateValue).getTime();
        const age = now - docDate;
        const freshness = Math.max(0, 1 - age / decayMs);
        const boost = 1 + (maxBoost - 1) * freshness;

        return { ...doc, score: doc.score * boost };
      });
    }

    // Sort by final score and limit
    scoredResults.sort((a, b) => b.score - a.score);
    scoredResults = scoredResults.slice(0, this.config.limit);

    // Format context
    const content = this.formatResultsToContext(scoredResults);

    return {
      content,
      metadata: {
        plugin: this.name,
        contentCount: scoredResults.length,
        types: [...new Set(scoredResults.map(d => d.metadata.type))],
        topResults: scoredResults.slice(0, 5).map(doc => ({
          id: doc.id,
          type: doc.metadata.type,
          title: doc.metadata.title,
          url: doc.metadata.url,
          imageUrl: doc.metadata.imageUrl,
          description: doc.metadata.description,
          score: doc.score,
        })),
      },
    };
  }

  /**
   * Format retrieved content for LLM context
   */
  private formatResultsToContext(docs: Array<StoredWebDocument & { score: number }>): string {
    if (docs.length === 0) {
      return 'No relevant content found.';
    }

    const sections: string[] = ['## Relevant Content\n'];

    for (const doc of docs) {
      const meta = doc.metadata;
      const header = meta.title || `${meta.type} (${doc.id})`;

      sections.push(`### ${header}`);

      if (meta.type) sections.push(`**Type:** ${meta.type}`);
      if (meta.url) sections.push(`**URL:** ${meta.url}`);

      // Add any other metadata fields (excluding internal ones)
      const skipFields = ['type', 'title', 'url', 'sourceUrl', 'fetchedAt'];
      const extraMeta = Object.entries(meta)
        .filter(([key]) => !skipFields.includes(key))
        .map(([key, value]) => `**${this.formatFieldName(key)}:** ${this.formatFieldValue(value)}`);

      if (extraMeta.length > 0) {
        sections.push(extraMeta.join('\n'));
      }

      sections.push('');
      sections.push(doc.content);
      sections.push('');
    }

    return sections.join('\n');
  }

  private formatFieldName(key: string): string {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
  }

  private formatFieldValue(value: any): string {
    if (Array.isArray(value)) return value.join(', ');
    if (value instanceof Date) return value.toLocaleDateString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  // ============================================================================
  // Vector Search
  // ============================================================================

  private async vectorSearch(options: {
    queryVector: number[];
    hardFilters: Record<string, any>;
  }): Promise<Array<StoredWebDocument & { score: number }>> {
    const collection = await this.getCollection();

    const pipeline: any[] = [
      {
        $vectorSearch: {
          index: this.config.vectorIndexName,
          path: 'embedding',
          queryVector: options.queryVector,
          numCandidates: this.config.numCandidates,
          limit: this.config.limit! * 2,  // Fetch more for post-filtering
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
    if (this.config.minScore) {
      pipeline.push({
        $match: { score: { $gte: this.config.minScore } },
      });
    }

    pipeline.push({ $limit: this.config.limit! * 2 });

    const results = await collection.aggregate(pipeline).toArray();

    return results as Array<StoredWebDocument & { score: number }>;
  }

  // ============================================================================
  // Embedding Generation
  // ============================================================================

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

    // Generate embedding
    const response = await this.openai.embeddings.create({
      model: this.config.embeddingModel!,
      input: text,
    });

    const embedding = response.data[0].embedding;

    // Cache result
    if (cacheConfig?.enabled) {
      const maxSize = cacheConfig.maxSize ?? 1000;
      if (this.embeddingCache.size >= maxSize) {
        // Remove oldest entry
        const firstKey = this.embeddingCache.keys().next().value;
        if (firstKey) this.embeddingCache.delete(firstKey);
      }
      this.embeddingCache.set(text, { value: embedding, timestamp: Date.now() });
    }

    return embedding;
  }

  private async generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];

    for (const text of texts) {
      const embedding = await this.generateEmbedding(text);
      embeddings.push(embedding);
    }

    return embeddings;
  }

  // ============================================================================
  // Chunking
  // ============================================================================

  /**
   * Split content into chunks by paragraph boundaries, respecting maxChunkSize.
   * Returns the original content as a single chunk when chunking is disabled
   * (maxChunkSize === 0) or the content fits within maxChunkSize.
   */
  private chunkContent(content: string): string[] {
    const maxSize = this.config.maxChunkSize ?? 1500;
    if (maxSize === 0 || content.length <= maxSize) {
      return [content];
    }

    const overlap = this.config.chunkOverlap ?? 200;
    const paragraphs = content.split(/\n\n+/);
    const chunks: string[] = [];
    let current = '';

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;

      // If a single paragraph exceeds maxSize, split it with overlap
      if (trimmed.length > maxSize) {
        if (current.trim()) {
          chunks.push(current.trim());
          current = '';
        }
        for (let i = 0; i < trimmed.length; i += maxSize - overlap) {
          const slice = trimmed.slice(i, i + maxSize);
          if (slice.trim()) chunks.push(slice.trim());
        }
        continue;
      }

      const candidate = current ? current + '\n\n' + trimmed : trimmed;
      if (candidate.length > maxSize) {
        if (current.trim()) {
          chunks.push(current.trim());
        }
        current = trimmed;
      } else {
        current = candidate;
      }
    }

    if (current.trim()) {
      chunks.push(current.trim());
    }

    return chunks.length > 0 ? chunks : [content];
  }

  // ============================================================================
  // Document Ingestion
  // ============================================================================

  /**
   * Ingest documents into the CMS RAG system
   */
  async ingest(
    documents: RAGDocument[],
    options?: IngestOptions
  ): Promise<IngestResult> {
    const collection = await this.getCollection();

    let indexed = 0;
    const errors: Array<{ id: string; error: string }> = [];
    const agentId = options?.agentId || 'shared';

    for (const doc of documents) {
      try {
        const chunks = this.chunkContent(doc.content);
        const isChunked = chunks.length > 1;

        // Remove any previous chunks for this document before re-ingesting
        if (isChunked) {
          await collection.deleteMany({
            tenantId: this.config.tenantId,
            documentId: doc.id,
            agentId,
          });
        }

        for (let i = 0; i < chunks.length; i++) {
          const chunkId = isChunked ? `chunk-${doc.id}-${i}` : doc.id;
          const embedding = await this.generateEmbedding(chunks[i]);

          const storedDoc: any = {
            id: chunkId,
            content: chunks[i],
            metadata: {
              type: doc.metadata?.type || 'content',
              ...doc.metadata,
            },
            tenantId: this.config.tenantId,
            agentId,
            embedding,
          };

          if (isChunked) {
            storedDoc.documentId = doc.id;
            storedDoc.chunkIndex = i;
          }

          await collection.updateOne(
            { tenantId: this.config.tenantId, id: chunkId, agentId },
            {
              $set: { ...storedDoc, updatedAt: new Date() },
              $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true }
          );
        }

        indexed++;
      } catch (error) {
        errors.push({
          id: doc.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return {
      success: errors.length === 0,
      indexed,
      failed: errors.length,
      errors: errors.length > 0 ? errors : undefined,
      metadata: {
        tenantId: this.config.tenantId,
        collection: this.config.collection,
      },
    };
  }

  /**
   * Update a single document.
   * When content changes the document is re-chunked (old chunks removed, new ones inserted).
   */
  async update(
    id: string,
    document: Partial<RAGDocument>,
    options?: IngestOptions
  ): Promise<void> {
    const agentId = options?.agentId || 'shared';

    // If content changed, re-ingest so chunking is applied correctly
    if (document.content) {
      const fullDoc: RAGDocument = {
        id,
        content: document.content,
        metadata: document.metadata ?? { type: 'content' },
      };
      // Delete old chunks/row then re-ingest
      await this.delete(id, options);
      await this.ingest([fullDoc], options);
      return;
    }

    // Metadata-only update: patch all chunks (or the single row)
    const collection = await this.getCollection();
    const metaUpdate: any = { updatedAt: new Date() };
    if (document.metadata) {
      for (const [key, value] of Object.entries(document.metadata)) {
        metaUpdate[`metadata.${key}`] = value;
      }
    }

    // Update the single-row case (id matches) and chunked case (documentId matches)
    await collection.updateMany(
      {
        tenantId: this.config.tenantId,
        agentId,
        $or: [{ id }, { documentId: id }],
      },
      { $set: metaUpdate }
    );
  }

  /**
   * Delete document(s) by ID — also removes any chunks belonging to the document.
   */
  async delete(
    ids: string | string[],
    options?: IngestOptions
  ): Promise<number> {
    const collection = await this.getCollection();

    const idArray = Array.isArray(ids) ? ids : [ids];

    const filter: any = {
      tenantId: this.config.tenantId,
      agentId: options?.agentId || 'shared',
      // Match the document itself (id) OR any chunks that belong to it (documentId)
      $or: [
        { id: { $in: idArray } },
        { documentId: { $in: idArray } },
      ],
    };

    const result = await collection.deleteMany(filter);
    return result.deletedCount;
  }

  /**
   * Bulk operations
   */
  async bulk(
    operations: BulkOperation[],
    options?: IngestOptions
  ): Promise<BulkResult> {
    let inserted = 0;
    let updated = 0;
    let deleted = 0;
    let failed = 0;
    const errors: Array<{ id: string; operation: string; error: string }> = [];

    for (const op of operations) {
      try {
        switch (op.type) {
          case 'insert':
            if (op.document) {
              await this.ingest([op.document], options);
              inserted++;
            }
            break;
          case 'update':
            if (op.document) {
              await this.update(op.id, op.document, options);
              updated++;
            }
            break;
          case 'delete':
            const count = await this.delete(op.id, options);
            deleted += count;
            break;
        }
      } catch (error: any) {
        failed++;
        errors.push({
          id: op.id,
          operation: op.type,
          error: error.message || 'Unknown error',
        });
      }
    }

    return {
      success: failed === 0,
      inserted,
      updated,
      deleted,
      failed,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  // ============================================================================
  // URL Ingestion
  // ============================================================================

  /**
   * Ingest content from a URL (JSON, CSV, XML, or API)
   */
  async ingestFromUrl(
    source: URLSource,
    options?: IngestOptions
  ): Promise<WebURLIngestResult> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), source.timeout || 30000);

      const response = await fetch(source.url, {
        headers: {
          ...source.headers,
          ...(source.auth && this.buildAuthHeaders(source.auth)),
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
      }

      // Transform data to documents
      let documents: RAGDocument[];

      if (source.type === 'json' || source.type === 'api') {
        const data = await response.json();
        documents = this.transformJsonToDocuments(data, source.transform);
      } else if (source.type === 'csv') {
        const data = await response.text();
        documents = this.transformCsvToDocuments(data, source.transform);
      } else if (source.type === 'xml') {
        const data = await response.text();
        documents = this.transformXmlToDocuments(data, source.transform);
      } else {
        throw new Error(`Unsupported source type: ${source.type}`);
      }

      // Add source metadata
      documents = documents.map(doc => ({
        ...doc,
        metadata: {
          ...doc.metadata,
          ...source.metadata,
          sourceUrl: source.url,
          fetchedAt: new Date().toISOString(),
        },
      }));

      const ingestResult = await this.ingest(documents, options);

      return {
        ...ingestResult,
        sourceUrl: source.url,
        fetchedAt: new Date(),
        documentsFetched: documents.length,
      };
    } catch (error) {
      return {
        success: false,
        indexed: 0,
        failed: 0,
        sourceUrl: source.url,
        fetchedAt: new Date(),
        documentsFetched: 0,
        errors: [{
          id: 'fetch',
          error: error instanceof Error ? error.message : 'Unknown error',
        }],
      };
    }
  }

  private buildAuthHeaders(auth: URLSource['auth']): Record<string, string> {
    if (!auth) return {};

    switch (auth.type) {
      case 'bearer':
        return auth.token ? { Authorization: `Bearer ${auth.token}` } : {};
      case 'basic':
        if (auth.username && auth.password) {
          const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
          return { Authorization: `Basic ${encoded}` };
        }
        return {};
      case 'api-key':
        return auth.header && auth.key ? { [auth.header]: auth.key } : {};
      case 'custom':
        return auth.headers || {};
      default:
        return {};
    }
  }

  private transformJsonToDocuments(
    data: any,
    transform?: URLSource['transform']
  ): RAGDocument[] {
    let items = data;

    // Apply document path (e.g., 'data' for JSON:API)
    if (transform?.documentPath) {
      items = this.extractByPath(data, transform.documentPath);
    }

    if (!Array.isArray(items)) {
      items = [items];
    }

    const fieldMapping = transform?.fieldMapping || {};

    return items.map((item: any, index: number) => {
      const metadata: Record<string, any> = {};

      // Map all fields except id and content to metadata
      for (const [targetField, sourcePath] of Object.entries(fieldMapping)) {
        if (targetField === 'id' || targetField === 'content') continue;

        if (typeof sourcePath === 'function') {
          metadata[targetField] = sourcePath();
        } else if (sourcePath) {
          metadata[targetField] = this.extractField(item, sourcePath);
        }
      }

      // Get type from mapping or default
      if (!metadata.type) {
        metadata.type = 'content';
      }

      return {
        id: this.extractField(item, fieldMapping.id as string || 'id') || `doc-${index}`,
        content: this.extractField(item, fieldMapping.content as string || 'content') || JSON.stringify(item),
        metadata,
      };
    });
  }

  private transformCsvToDocuments(
    csvData: string,
    transform?: URLSource['transform']
  ): RAGDocument[] {
    const lines = csvData.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = this.parseCsvLine(lines[0]);

    return lines.slice(1).map((line, index) => {
      const values = this.parseCsvLine(line);
      const item = headers.reduce((acc, header, i) => {
        acc[header] = values[i] || '';
        return acc;
      }, {} as Record<string, string>);

      return this.transformJsonToDocuments([item], transform)[0];
    });
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());

    return result;
  }

  private transformXmlToDocuments(
    xmlData: string,
    transform?: URLSource['transform']
  ): RAGDocument[] {
    // Simple XML parsing - extracts text content from tags
    // For complex XML, consider using a proper XML parser
    const items: any[] = [];
    const itemPath = transform?.documentPath || 'item';

    // Extract items using regex (simple approach)
    const itemRegex = new RegExp(`<${itemPath}[^>]*>([\\s\\S]*?)<\\/${itemPath}>`, 'gi');
    let match;

    while ((match = itemRegex.exec(xmlData)) !== null) {
      const itemXml = match[1];
      const item: Record<string, string> = {};

      // Extract tag contents
      const tagRegex = /<(\w+)[^>]*>([^<]*)<\/\1>/g;
      let tagMatch;
      while ((tagMatch = tagRegex.exec(itemXml)) !== null) {
        item[tagMatch[1]] = tagMatch[2].trim();
      }

      items.push(item);
    }

    return this.transformJsonToDocuments(items, transform);
  }

  private extractByPath(obj: any, path: string): any {
    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current == null) return undefined;

      // Handle array notation like 'items[0]'
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        current = current[arrayMatch[1]]?.[parseInt(arrayMatch[2])];
      } else {
        current = current[part];
      }
    }

    return current;
  }

  private extractField(item: any, path: string): any {
    return this.extractByPath(item, path);
  }

  // ============================================================================
  // Drupal JSON:API Integration
  // ============================================================================

  /**
   * Ingest content from a Drupal site using JSON:API
   */
  async ingestFromDrupal(
    config: DrupalConfig,
    options?: IngestOptions
  ): Promise<WebURLIngestResult[]> {
    const results: WebURLIngestResult[] = [];

    for (const contentType of config.contentTypes) {
      const url = `${config.baseUrl}/jsonapi/node/${contentType}`;
      const mapping = config.mappings?.[contentType];

      const result = await this.ingestFromUrl(
        {
          url,
          type: 'json',
          auth: config.auth,
          transform: {
            documentPath: 'data',
            fieldMapping: {
              id: 'id',
              content: mapping?.content || 'attributes.body.processed',
              type: () => contentType,
              title: 'attributes.title',
              url: 'attributes.path.alias',
              ...mapping?.fields,
            },
          },
        },
        options
      );

      results.push(result);
    }

    return results;
  }

  /**
   * Parse Drupal JSON:API node type (e.g., 'node--project' → 'project')
   */
  static parseDrupalType(type: string): string {
    return type.replace(/^node--/, '');
  }

  // ============================================================================
  // WordPress REST API Integration
  // ============================================================================

  /**
   * Ingest content from a WordPress site using REST API
   * 
   * @example
   * ```typescript
   * await plugin.ingestFromWordPress({
   *   baseUrl: 'https://myblog.com',
   *   postTypes: ['posts', 'pages'],
   *   perPage: 100,
   * });
   * ```
   */
  async ingestFromWordPress(
    config: WordPressConfig,
    options?: IngestOptions
  ): Promise<WebURLIngestResult[]> {
    const results: WebURLIngestResult[] = [];
    const postTypes = config.postTypes || ['posts', 'pages'];
    const perPage = config.perPage || 100;
    const maxPages = config.maxPages || 10;

    for (const postType of postTypes) {
      let page = 1;
      let hasMore = true;

      while (hasMore && page <= maxPages) {
        const url = `${config.baseUrl}/wp-json/wp/v2/${postType}?per_page=${perPage}&page=${page}&_embed`;
        const mapping = config.mappings?.[postType];

        try {
          const result = await this.ingestFromUrl(
            {
              url,
              type: 'json',
              auth: config.auth,
              transform: {
                fieldMapping: {
                  id: 'id',
                  content: mapping?.content || 'content.rendered',
                  type: () => this.normalizeWordPressType(postType),
                  title: 'title.rendered',
                  url: 'link',
                  slug: 'slug',
                  publishedAt: 'date',
                  modifiedAt: 'modified',
                  author: '_embedded.author.0.name',
                  featuredImage: '_embedded.wp:featuredmedia.0.source_url',
                  excerpt: 'excerpt.rendered',
                  categories: '_embedded.wp:term.0',
                  tags: '_embedded.wp:term.1',
                  ...mapping?.fields,
                },
              },
            },
            options
          );

          results.push(result);

          // Check if there are more pages
          hasMore = result.documentsFetched === perPage;
          page++;
        } catch (error) {
          // No more pages or error
          hasMore = false;
        }
      }
    }

    return results;
  }

  /**
   * Normalize WordPress post type to a cleaner name
   */
  private normalizeWordPressType(postType: string): string {
    // Convert 'posts' → 'post', 'pages' → 'page'
    if (postType.endsWith('s')) {
      return postType.slice(0, -1);
    }
    return postType;
  }

  // ============================================================================
  // Sanity.io Integration
  // ============================================================================

  /**
   * Ingest content from a Sanity.io project using GROQ queries
   * 
   * @example
   * ```typescript
   * await plugin.ingestFromSanity({
   *   projectId: 'abc123',
   *   dataset: 'production',
   *   queries: {
   *     post: {
   *       query: '*[_type == "post" && !(_id in path("drafts.**"))]',
   *       content: 'body',
   *       fields: {
   *         author: 'author->name',
   *         categories: 'categories[]->title',
   *       },
   *     },
   *   },
   * });
   * ```
   */
  async ingestFromSanity(
    config: SanityConfig,
    options?: IngestOptions
  ): Promise<WebURLIngestResult[]> {
    const results: WebURLIngestResult[] = [];
    const apiVersion = config.apiVersion || 'v2024-01-01';
    const useCdn = config.useCdn !== false;

    const baseUrl = useCdn
      ? `https://${config.projectId}.apicdn.sanity.io/${apiVersion}`
      : `https://${config.projectId}.api.sanity.io/${apiVersion}`;

    for (const [contentType, queryConfig] of Object.entries(config.queries)) {
      const encodedQuery = encodeURIComponent(queryConfig.query);
      const url = `${baseUrl}/data/query/${config.dataset}?query=${encodedQuery}`;

      const headers: Record<string, string> = {};
      if (config.token) {
        headers['Authorization'] = `Bearer ${config.token}`;
      }

      const result = await this.ingestFromUrl(
        {
          url,
          type: 'json',
          headers,
          transform: {
            documentPath: 'result',
            fieldMapping: {
              id: '_id',
              content: queryConfig.content,
              type: () => contentType,
              title: 'title',
              slug: 'slug.current',
              publishedAt: 'publishedAt',
              updatedAt: '_updatedAt',
              ...queryConfig.fields,
            },
          },
        },
        options
      );

      results.push(result);
    }

    return results;
  }

  /**
   * Convert Sanity Portable Text blocks to plain text
   * Useful for extracting content from rich text fields
   */
  static sanityBlocksToText(blocks: any[]): string {
    if (!Array.isArray(blocks)) return '';

    return blocks
      .filter((block) => block._type === 'block')
      .map((block) => {
        if (!block.children) return '';
        return block.children
          .map((child: any) => child.text || '')
          .join('');
      })
      .join('\n\n');
  }

  // ============================================================================
  // Strapi Integration
  // ============================================================================

  /**
   * Ingest content from a Strapi CMS (v4 by default)
   * 
   * @example
   * ```typescript
   * await plugin.ingestFromStrapi({
   *   baseUrl: 'https://my-strapi.com',
   *   apiToken: process.env.STRAPI_TOKEN,
   *   contentTypes: ['articles', 'pages'],
   *   mappings: {
   *     articles: {
   *       content: 'attributes.content',
   *       fields: {
   *         author: 'attributes.author.data.attributes.name',
   *         category: 'attributes.category.data.attributes.name',
   *       },
   *     },
   *   },
   * });
   * ```
   */
  async ingestFromStrapi(
    config: StrapiConfig,
    options?: IngestOptions
  ): Promise<WebURLIngestResult[]> {
    const results: WebURLIngestResult[] = [];
    const pageSize = config.pageSize || 100;
    const maxPages = config.maxPages || 10;

    for (const contentType of config.contentTypes) {
      let page = 1;
      let hasMore = true;
      const mapping = config.mappings?.[contentType];
      const useAttributes = mapping?.useAttributes !== false; // Default true for Strapi v4

      while (hasMore && page <= maxPages) {
        // Strapi v4 pagination
        const url = `${config.baseUrl}/api/${contentType}?pagination[page]=${page}&pagination[pageSize]=${pageSize}&populate=*`;

        const headers: Record<string, string> = {};
        if (config.apiToken) {
          headers['Authorization'] = `Bearer ${config.apiToken}`;
        }

        try {
          const result = await this.ingestFromUrl(
            {
              url,
              type: 'json',
              headers,
              transform: {
                documentPath: 'data',
                fieldMapping: useAttributes
                  ? {
                    // Strapi v4 format (with attributes)
                    id: 'id',
                    content: mapping?.content || 'attributes.content',
                    type: () => this.normalizeStrapiType(contentType),
                    title: 'attributes.title',
                    slug: 'attributes.slug',
                    publishedAt: 'attributes.publishedAt',
                    updatedAt: 'attributes.updatedAt',
                    ...mapping?.fields,
                  }
                  : {
                    // Strapi v3 format (flat)
                    id: 'id',
                    content: mapping?.content || 'content',
                    type: () => this.normalizeStrapiType(contentType),
                    title: 'title',
                    slug: 'slug',
                    publishedAt: 'published_at',
                    updatedAt: 'updated_at',
                    ...mapping?.fields,
                  },
              },
            },
            options
          );

          results.push(result);

          // Check pagination meta for more pages
          hasMore = result.documentsFetched === pageSize;
          page++;
        } catch (error) {
          hasMore = false;
        }
      }
    }

    return results;
  }

  /**
   * Normalize Strapi collection type to singular form
   */
  private normalizeStrapiType(collectionType: string): string {
    // Convert 'articles' → 'article', 'pages' → 'page'
    if (collectionType.endsWith('s')) {
      return collectionType.slice(0, -1);
    }
    return collectionType;
  }

  // ============================================================================
  // Web Crawling - Zero Setup for Non-Technical Clients
  // ============================================================================

  /**
   * Ingest content by crawling a website's sitemap
   * Perfect for non-technical clients - just provide the sitemap URL
   * 
   * @example
   * ```typescript
   * // Simple usage - just provide the sitemap
   * await plugin.ingestFromSitemap({
   *   sitemapUrl: 'https://my-site/sitemap.xml',
   * });
   * 
   * // Or auto-discover sitemap from base URL
   * await plugin.ingestFromSitemap({
   *   baseUrl: 'https://my-site',
   * });
   * 
   * // With content selectors and type inference
   * await plugin.ingestFromSitemap({
   *   sitemapUrl: 'https://my-site/sitemap.xml',
   *   contentSelector: 'article, .main-content',
   *   excludePatterns: ['/cart', '/checkout', '/admin'],
   *   typeFromUrl: {
   *     '/projects/': 'project',
   *     '/perspectives/': 'blog',
   *     '/people/': 'team',
   *   },
   * });
   * ```
   */
  async ingestFromSitemap(
    config: SitemapConfig,
    options?: IngestOptions
  ): Promise<CrawlResult> {
    const maxPages = config.maxPages ?? 100;
    const concurrency = config.concurrency ?? 3;
    const delayMs = config.delayMs ?? 500;

    // Determine sitemap URL
    let sitemapUrl = config.sitemapUrl;
    if (!sitemapUrl && config.baseUrl) {
      sitemapUrl = `${config.baseUrl.replace(/\/$/, '')}/sitemap.xml`;
    }

    if (!sitemapUrl) {
      return {
        success: false,
        indexed: 0,
        failed: 0,
        urlsCrawled: 0,
        urlsSkipped: 0,
        urlsFailed: 0,
        crawledAt: new Date(),
        errors: [{ id: 'config', error: 'Either sitemapUrl or baseUrl is required' }],
      };
    }

    // Fetch and parse sitemap
    const urls = await this.parseSitemap(sitemapUrl, config);

    // Apply filters
    let filteredUrls = urls;
    if (config.includePatterns?.length) {
      filteredUrls = filteredUrls.filter(url =>
        config.includePatterns!.some(pattern => url.includes(pattern))
      );
    }
    if (config.excludePatterns?.length) {
      filteredUrls = filteredUrls.filter(url =>
        !config.excludePatterns!.some(pattern => url.includes(pattern))
      );
    }

    // Limit URLs
    const urlsToCrawl = filteredUrls.slice(0, maxPages);
    const urlsSkipped = filteredUrls.length - urlsToCrawl.length;

    // Crawl URLs with concurrency control
    const result = await this.crawlUrls(urlsToCrawl, {
      ...config,
      concurrency,
      delayMs,
    }, options);

    return {
      ...result,
      urlsSkipped,
      crawledAt: new Date(),
    };
  }

  /**
   * Ingest content from a website that has no sitemap (or sitemap is incomplete).
   * Discovers internal links from `baseUrl` (BFS) and then crawls the discovered URLs.
   *
   * This uses the same extraction pipeline as `ingestFromSitemap()` (via `crawlPage()`).
   */
  async ingestFromWebsite(
    config: WebsiteCrawlConfig,
    options?: IngestOptions
  ): Promise<CrawlResult> {
    const maxPages = config.maxPages ?? 100;
    const maxDepth = config.maxDepth ?? 3;
    const concurrency = config.concurrency ?? 3;
    const delayMs = config.delayMs ?? 500;
    const timeout = config.timeout ?? 30000;
    const stripQueryParams = config.stripQueryParams ?? true;

    if (!config.baseUrl) {
      return {
        success: false,
        indexed: 0,
        failed: 0,
        urlsCrawled: 0,
        urlsSkipped: 0,
        urlsFailed: 0,
        crawledAt: new Date(),
        errors: [{ id: 'config', error: 'baseUrl is required' }],
      };
    }

    const dbg = this.createDebugCollector(config.debug);

    const base = this.normalizeWebsiteUrl(config.baseUrl, stripQueryParams);
    if (!base) {
      return {
        success: false,
        indexed: 0,
        failed: 0,
        urlsCrawled: 0,
        urlsSkipped: 0,
        urlsFailed: 0,
        crawledAt: new Date(),
        errors: [{ id: 'config', error: 'Invalid baseUrl' }],
      };
    }

    // 1) Try robots.txt sitemaps, then common sitemap candidates
    const discoveredSitemaps = await this.discoverSitemaps(base, timeout, dbg);
    dbg.log('discovery.sitemaps', { baseUrl: base, sitemaps: discoveredSitemaps });

    let urlsToCrawl: string[] = [];
    let urlsSkipped = 0;

    for (const sm of discoveredSitemaps) {
      const urls = await this.parseSitemap(sm, {
        sitemapUrl: sm,
        timeout,
      });
      if (urls.length > 0) {
        dbg.log('discovery.sitemapParsed', { sitemapUrl: sm, urlCount: urls.length });

        let filteredUrls = urls;
        if (config.includePatterns?.length) {
          filteredUrls = filteredUrls.filter(u => config.includePatterns!.some(p => u.includes(p)));
        }
        if (config.excludePatterns?.length) {
          filteredUrls = filteredUrls.filter(u => !config.excludePatterns!.some(p => u.includes(p)));
        }

        urlsToCrawl = filteredUrls.slice(0, maxPages);
        urlsSkipped = Math.max(0, filteredUrls.length - urlsToCrawl.length);
        break;
      }
    }

    // 2) Fallback: link lookup (BFS) if sitemap yielded nothing
    if (urlsToCrawl.length === 0) {
      dbg.log('discovery.fallback', { reason: 'no_sitemap_urls', method: 'link_lookup' });
      const discovery = await this.discoverInternalUrls({
        baseUrl: base,
        maxPages,
        maxDepth,
        concurrency,
        delayMs,
        timeout,
        includePatterns: config.includePatterns,
        excludePatterns: config.excludePatterns,
        stripQueryParams,
      });
      urlsToCrawl = discovery.urls;
      urlsSkipped = discovery.skipped;
      dbg.log('discovery.linkLookup', { discovered: urlsToCrawl.length, skipped: urlsSkipped });
    }

    const result = await this.crawlUrls(urlsToCrawl, {
      contentSelector: config.contentSelector,
      titleSelector: config.titleSelector,
      removeSelectors: config.removeSelectors,
      concurrency,
      delayMs,
      timeout,
      typeFromUrl: config.typeFromUrl,
      defaultType: config.defaultType ?? 'page',
      metadata: config.metadata,
      includePatterns: config.includePatterns,
      excludePatterns: config.excludePatterns,
      stripQueryParams,
      render: config.render,
      renderOptions: config.renderOptions,
      debug: config.debug,
      crawlLedger: config.crawlLedger,
    }, options);

    return {
      ...result,
      urlsSkipped,
      crawledAt: new Date(),
      metadata: {
        ...(result.metadata || {}),
        discoveryDebug: dbg.summary(),
      },
    };
  }

  /**
   * Parse sitemap XML and extract URLs
   */
  private async parseSitemap(
    sitemapUrl: string,
    config: SitemapConfig
  ): Promise<string[]> {
    const urls: string[] = [];

    try {
      const response = await fetch(sitemapUrl, {
        headers: { 'User-Agent': 'SnapAgent-CMS-Crawler/1.0' },
        signal: AbortSignal.timeout(config.timeout || 30000),
      });

      if (!response.ok) {
        console.error(`Failed to fetch sitemap: ${response.status}`);
        return urls;
      }

      const xml = await response.text();

      // Check if it's a sitemap index (contains other sitemaps)
      if (xml.includes('<sitemapindex')) {
        const sitemapUrls = this.extractUrlsFromXml(xml, 'sitemap', 'loc');
        // Recursively fetch each sitemap
        for (const subSitemapUrl of sitemapUrls.slice(0, 10)) { // Limit to 10 sub-sitemaps
          const subUrls = await this.parseSitemap(subSitemapUrl, config);
          urls.push(...subUrls);
        }
      } else {
        // Regular sitemap
        const pageUrls = this.extractUrlsFromXml(xml, 'url', 'loc');
        urls.push(...pageUrls);
      }
    } catch (error) {
      console.error(`Error parsing sitemap ${sitemapUrl}:`, error);
    }

    return urls;
  }

  /**
   * Extract URLs from sitemap XML
   */
  private extractUrlsFromXml(xml: string, parentTag: string, urlTag: string): string[] {
    const urls: string[] = [];
    const regex = new RegExp(`<${parentTag}[^>]*>[\\s\\S]*?<${urlTag}>([^<]+)<\\/${urlTag}>[\\s\\S]*?<\\/${parentTag}>`, 'gi');

    let match;
    while ((match = regex.exec(xml)) !== null) {
      const url = match[1].trim();
      if (url.startsWith('http')) {
        urls.push(url);
      }
    }

    return urls;
  }

  private async discoverInternalUrls(input: {
    baseUrl: string;
    maxPages: number;
    maxDepth: number;
    concurrency: number;
    delayMs: number;
    timeout: number;
    includePatterns?: string[];
    excludePatterns?: string[];
    stripQueryParams: boolean;
  }): Promise<{ urls: string[]; skipped: number }> {
    const start = this.normalizeWebsiteUrl(input.baseUrl, input.stripQueryParams);
    if (!start) return { urls: [], skipped: 0 };

    const startUrl = new URL(start);
    const visited = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = [{ url: startUrl.toString(), depth: 0 }];
    const discovered: string[] = [];

    let skipped = 0;

    while (queue.length > 0 && discovered.length < input.maxPages) {
      const batch = queue.splice(0, input.concurrency);

      const results = await Promise.allSettled(
        batch.map(async ({ url, depth }) => {
          if (visited.has(url)) return { url, depth, links: [] as string[] };
          visited.add(url);

          if (depth > input.maxDepth) return { url, depth, links: [] as string[] };

          // Apply include/exclude filters before fetching
          if (input.includePatterns?.length && !input.includePatterns.some(p => url.includes(p))) {
            skipped++;
            return { url, depth, links: [] as string[] };
          }
          if (input.excludePatterns?.length && input.excludePatterns.some(p => url.includes(p))) {
            skipped++;
            return { url, depth, links: [] as string[] };
          }

          discovered.push(url);

          // Stop discovery early if we've hit the page limit
          if (discovered.length >= input.maxPages) return { url, depth, links: [] as string[] };

          try {
            const html = await this.fetchHtml(url, input.timeout);
            if (!html) return { url, depth, links: [] as string[] };
            const links = this.extractInternalLinks(html, startUrl, input.stripQueryParams);
            return { url, depth, links };
          } catch {
            // Discovery errors shouldn't block the overall crawl
            return { url, depth, links: [] as string[] };
          }
        })
      );

      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { depth, links } = r.value;
        const nextDepth = depth + 1;
        if (nextDepth > input.maxDepth) continue;
        for (const link of links) {
          if (discovered.length + queue.length >= input.maxPages * 3) continue; // small safety cap
          if (visited.has(link)) continue;
          queue.push({ url: link, depth: nextDepth });
        }
      }

      if (queue.length > 0 && discovered.length < input.maxPages) {
        await this.delay(input.delayMs);
      }
    }

    // If we hit maxPages during discovery, count remaining queued URLs as skipped (they were discoverable but not crawled)
    if (discovered.length >= input.maxPages) {
      skipped += queue.length;
    }

    return { urls: discovered.slice(0, input.maxPages), skipped };
  }

  private normalizeWebsiteUrl(inputUrl: string, stripQueryParams: boolean): string | null {
    try {
      const u = new URL(inputUrl);
      u.hash = '';
      if (stripQueryParams) u.search = '';
      return u.toString();
    } catch {
      return null;
    }
  }

  private async fetchHtml(url: string, timeout: number): Promise<string | null> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'SnapAgent-CMS-Crawler/1.0',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    return await response.text();
  }

  private extractInternalLinks(html: string, base: URL, stripQueryParams: boolean): string[] {
    const $ = cheerio.load(html);
    const links = new Set<string>();

    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      if (!href) return;
      if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;

      try {
        const u = new URL(href, base);
        // Same origin only
        if (u.origin !== base.origin) return;
        u.hash = '';
        if (stripQueryParams) u.search = '';

        links.add(u.toString());
      } catch {
        // ignore invalid URLs
      }
    });

    return Array.from(links);
  }

  /**
   * Ingest content from a list of URLs
   * 
   * @example
   * ```typescript
   * await plugin.ingestFromUrls([
   *   'https://example.com/about',
   *   'https://example.com/services',
   *   'https://example.com/contact',
   * ], {
   *   contentSelector: '.page-content',
   *   type: 'page',
   * });
   * ```
   */
  async ingestFromUrls(
    urls: string[],
    config: UrlListConfig = {},
    options?: IngestOptions
  ): Promise<CrawlResult> {
    return this.crawlUrls(urls, {
      contentSelector: config.contentSelector,
      titleSelector: config.titleSelector,
      removeSelectors: config.removeSelectors,
      concurrency: config.concurrency ?? 3,
      delayMs: config.delayMs ?? 500,
      timeout: config.timeout ?? 30000,
      typeFromUrl: config.typeFromUrl,
      defaultType: config.type || 'page',
      metadata: config.metadata,
      stripQueryParams: config.stripQueryParams ?? false,
      render: config.render,
      renderOptions: config.renderOptions,
      debug: config.debug,
      crawlLedger: config.crawlLedger,
    }, options);
  }

  /**
   * Ingest a single page from a URL (no sitemap discovery, no link lookup).
   * Uses the same crawl pipeline (static/render/auto) as other web ingestion methods.
   */
  async ingestSinglePageFromUrl(
    config: SinglePageConfig,
    options?: IngestOptions
  ): Promise<CrawlResult> {
    if (!config?.url) {
      return {
        success: false,
        indexed: 0,
        failed: 0,
        urlsCrawled: 0,
        urlsSkipped: 0,
        urlsFailed: 0,
        crawledAt: new Date(),
        errors: [{ id: 'config', error: 'url is required' }],
      };
    }

    return this.crawlUrls([config.url], {
      contentSelector: config.contentSelector,
      titleSelector: config.titleSelector,
      removeSelectors: config.removeSelectors,
      concurrency: 1,
      delayMs: 0,
      timeout: config.timeout ?? 30000,
      typeFromUrl: config.typeFromUrl,
      defaultType: config.type || 'page',
      metadata: config.metadata,
      stripQueryParams: config.stripQueryParams ?? true,
      render: config.render,
      renderOptions: config.renderOptions,
      debug: config.debug,
      crawlLedger: config.crawlLedger,
    }, options);
  }

  /**
   * Crawl a list of URLs and ingest their content
   */
  private async crawlUrls(
    urls: string[],
    config: SitemapConfig & { defaultType?: string },
    options?: IngestOptions
  ): Promise<CrawlResult> {
    const concurrency = config.concurrency ?? 3;
    const delayMs = config.delayMs ?? 500;
    const timeout = config.timeout ?? 30000;
    const renderMode = config.render ?? false;
    const renderOptions: RenderOptions = config.renderOptions || {};
    const minContentLength = renderOptions.minContentLength ?? 200;
    const dbg = this.createDebugCollector(config.debug);
    const ledgerOpts = this.resolveCrawlLedgerOptions(config);
    const forceRecrawl = !!(options && (options as { forceRecrawl?: boolean }).forceRecrawl);
    const agentId = (options?.agentId as string | undefined) ?? 'shared';
    const stripQ = config.stripQueryParams ?? false;

    const urlByNorm = new Map<string, string>();
    for (const u of urls) {
      const norm = this.normalizeLedgerUrl(u, stripQ) || u;
      if (!urlByNorm.has(norm)) urlByNorm.set(norm, u);
    }
    const uniqueUrls = Array.from(urlByNorm.values());

    const counters = {
      staticOk: 0,
      renderOk: 0,
      renderFallbacks: 0,
      nonHtml: 0,
      tooSmall: 0,
      blockedSuspected: 0,
      renderErrors: 0,
      ledgerSkipped: 0,
    };

    let indexed = 0;
    let urlsCrawled = 0;
    let urlsFailed = 0;
    const errors: Array<{ id: string; error: string }> = [];
    const documents: RAGDocument[] = [];
    const pageStatuses: CrawlPageStatusEntry[] = [];
    const maxStatuses = ledgerOpts?.maxPageStatuses ?? 500;

    // Process URLs in batches for concurrency control
    for (let i = 0; i < uniqueUrls.length; i += concurrency) {
      const batch = uniqueUrls.slice(i, i + concurrency);

      const results = await Promise.allSettled(
        batch.map(async (url) => {
          const urlNormalized = this.normalizeLedgerUrl(url, stripQ) || url;

          if (ledgerOpts && !forceRecrawl) {
            const entry = await this.findLedgerEntry(urlNormalized, agentId);
            if (
              this.shouldSkipLedger(
                entry,
                ledgerOpts.ttlMsIndexed,
                ledgerOpts.ttlMsFailure,
                ledgerOpts.ttlMsRenderError,
                false
              )
            ) {
              counters.ledgerSkipped++;
              this.pushPageStatus(pageStatuses, maxStatuses, {
                url,
                urlNormalized,
                status: 'skipped_ledger',
                skippedReason: `fresh:${entry?.lastStatus}`,
                contentLength: entry?.contentLength,
                title: entry?.title,
                docId: entry?.docId,
              });
              dbg.log('crawl.ledgerSkip', { url, urlNormalized, lastStatus: entry?.lastStatus });
              return { kind: 'ledger_skip' as const, url };
            }
          }

          try {
            const { doc, diag, bodyTextLengthHint } = await this.crawlPageSmart(url, config, timeout, {
              renderMode,
              renderOptions,
              minContentLength,
              dbg,
            });
            if (diag?.modeUsed === 'static_ok') counters.staticOk++;
            if (diag?.modeUsed === 'render_ok') counters.renderOk++;
            if (diag?.modeUsed === 'render_fallback_ok') counters.renderFallbacks++;
            if (diag?.reason === 'non_html') counters.nonHtml++;
            if (diag?.reason === 'too_small') counters.tooSmall++;
            if (diag?.reason === 'blocked_suspected') counters.blockedSuspected++;
            if (diag?.reason === 'render_error') counters.renderErrors++;

            const crawlSt = this.toLedgerStatus(doc, diag);
            if (ledgerOpts) {
              await this.upsertLedgerRecord({
                url,
                urlNormalized,
                agentId,
                status: crawlSt,
                doc,
                diag,
              });
            }

            this.pushPageStatus(pageStatuses, maxStatuses, {
              url,
              urlNormalized,
              status: crawlSt,
              modeUsed: diag?.modeUsed,
              contentLength: doc?.content?.length,
              bodyTextLengthHint,
              title: doc?.metadata?.title,
              docId: doc?.id,
              error: diag?.errorMessage,
            });

            return { kind: 'doc' as const, doc, url };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (ledgerOpts) {
              await this.upsertLedgerRecord({
                url,
                urlNormalized,
                agentId,
                status: 'error',
                errorMessage: msg,
              });
            }
            this.pushPageStatus(pageStatuses, maxStatuses, {
              url,
              urlNormalized,
              status: 'error',
              error: msg,
            });
            throw { url, error };
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const v = result.value;
          if (v && typeof v === 'object' && 'kind' in v && v.kind === 'ledger_skip') {
            continue;
          }
          if (v && typeof v === 'object' && 'kind' in v && v.kind === 'doc' && v.doc) {
            documents.push(v.doc);
            urlsCrawled++;
          }
        } else if (result.status === 'rejected') {
          urlsFailed++;
          errors.push({
            id: result.reason.url || 'unknown',
            error: result.reason.error?.message || 'Failed to crawl',
          });
        }
      }

      // Delay between batches
      if (i + concurrency < uniqueUrls.length) {
        await this.delay(delayMs);
      }
    }

    // Ingest collected documents
    if (documents.length > 0) {
      const ingestResult = await this.ingest(documents, options);
      indexed = ingestResult.indexed;
      if (ingestResult.errors) {
        errors.push(...ingestResult.errors);
      }
    }

    return {
      success: errors.length === 0,
      indexed,
      failed: errors.length,
      urlsCrawled,
      urlsSkipped: 0,
      urlsFailed,
      crawledAt: new Date(),
      errors: errors.length > 0 ? errors : undefined,
      metadata: {
        counters,
        pageStatuses,
        debug: dbg.summary(),
      },
    };
  }

  /**
   * Crawl a single page and extract content
   */
  private async crawlPage(
    url: string,
    config: SitemapConfig,
    timeout: number
  ): Promise<RAGDocument | null> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'SnapAgent-CMS-Crawler/1.0',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return null; // Skip non-HTML content
    }

    const html = await response.text();
    return this.extractDocumentFromHtml(url, html, config);
  }

  /**
   * Default chain works for many WordPress / Elementor / block themes where `.first()`
   * would otherwise hit an empty wrapper.
   */
  private static readonly DEFAULT_CONTENT_SELECTOR =
    'article, main, [role="main"], #content, #primary, #main, .content, .post-content, ' +
    '.entry-content, .elementor-location-content, .elementor-widget-theme-post-content, ' +
    '.wp-block-group, .site-content, .ast-single-post, .ast-page';

  private stripNoiseFromDom($: cheerio.CheerioAPI, config: SitemapConfig): void {
    const removeSelectors = config.removeSelectors || [
      'script', 'style', 'nav', 'header', 'footer',
      '.sidebar', '.navigation', '.menu', '.comments',
      '[role="navigation"]', '[role="banner"]',
    ];
    removeSelectors.forEach(selector => $(selector).remove());
  }

  /** Longest cleaned text among selector matches and full body (after noise strip). */
  private extractBestContentText($: cheerio.CheerioAPI, config: SitemapConfig): string {
    const contentSelector =
      config.contentSelector || WebRAGPlugin.DEFAULT_CONTENT_SELECTOR;
    const selectors = contentSelector.split(',').map(s => s.trim()).filter(Boolean);
    let best = '';
    for (const sel of selectors) {
      $(sel).each((_, el) => {
        const t = this.cleanContent($(el).text().trim());
        if (t.length > best.length) best = t;
      });
    }
    const bodyText = this.cleanContent($('body').text().trim());
    if (bodyText.length > best.length) best = bodyText;
    return best;
  }

  private bodyTextLengthHint(html: string, config: SitemapConfig): number {
    const $ = cheerio.load(html);
    this.stripNoiseFromDom($, config);
    return this.cleanContent($('body').text().trim()).length;
  }

  private extractDocumentFromHtml(url: string, html: string, config: SitemapConfig): RAGDocument | null {
    const $ = cheerio.load(html);
    this.stripNoiseFromDom($, config);

    // Extract title
    const titleSelector = config.titleSelector || 'h1, title';
    let title = $(titleSelector).first().text().trim();
    if (!title) {
      title = $('title').text().trim();
    }

    const content = this.extractBestContentText($, config);
    const minChars = config.minExtractedContentLength ?? 50;
    if (!content || content.length < minChars) return null;

    // Extract representative image (priority chain)
    const image =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('meta[property="product:image"]').attr('content') ||
      $('[itemtype*="schema.org/Product"] img, .product img, .product-image img, #product-image img')
        .first().attr('src') ||
      // Fallback: largest/first meaningful image in main content area
      this.extractHeroImage($, url) ||
      undefined;

    // Resolve relative image URLs to absolute
    let imageUrl: string | undefined;
    if (image) {
      try {
        imageUrl = new URL(image, url).href;
      } catch {
        imageUrl = image;
      }
    }

    // Extract page description (og:description → meta description)
    const description =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      undefined;

    // Determine content type from URL
    let type = config.defaultType || 'page';
    if (config.typeFromUrl) {
      for (const [pattern, typeName] of Object.entries(config.typeFromUrl)) {
        if (url.includes(pattern)) {
          type = typeName;
          break;
        }
      }
    }

    const id = this.urlToId(url);
    return {
      id,
      content,
      metadata: {
        type,
        title,
        url,
        ...(imageUrl ? { imageUrl } : {}),
        ...(description ? { description } : {}),
        ...config.metadata,
      },
    };
  }

  /**
   * Fallback image extraction: finds the first meaningful image in the content area.
   * Skips icons, avatars, and tiny assets by filtering on common patterns.
   */
  private extractHeroImage($: cheerio.CheerioAPI, pageUrl: string): string | undefined {
    // Look in main content containers first, fall back to body
    const containers = $('main, article, [role="main"], #content, .content');
    const scope = containers.length > 0 ? containers : $('body');

    let best: string | undefined;
    scope.find('img[src]').each((_, el) => {
      if (best) return false; // stop after first match
      const src = $(el).attr('src') || '';
      const alt = ($(el).attr('alt') || '').toLowerCase();
      const width = parseInt($(el).attr('width') || '0', 10);
      const height = parseInt($(el).attr('height') || '0', 10);

      // Skip tiny images (icons, tracking pixels)
      if ((width > 0 && width < 80) || (height > 0 && height < 80)) return;
      // Skip common non-content patterns
      if (/logo|icon|avatar|favicon|badge|spinner|loading/i.test(src + ' ' + alt)) return;
      // Skip data URIs and SVGs
      if (src.startsWith('data:') || src.endsWith('.svg')) return;

      // Resolve relative/Next.js /_next/image URLs
      if (src.includes('/_next/image')) {
        // Extract the actual image URL from Next.js proxy: /_next/image?url=<encoded>&...
        try {
          const nextUrl = new URL(src, pageUrl);
          const realUrl = nextUrl.searchParams.get('url');
          if (realUrl) {
            best = realUrl.startsWith('http') ? realUrl : new URL(realUrl, pageUrl).href;
            return false;
          }
        } catch { /* fall through */ }
      }

      best = src;
      return false;
    });

    return best;
  }

  private looksLikeDynamicShell(html: string): boolean {
    const lower = html.toLowerCase();

    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const body = bodyMatch?.[1] ?? html;

    const textOnly = body
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const scriptCount = (body.match(/<script\b/gi) ?? []).length;

    const hasEmptyAppMountNode =
      /<(div|main)[^>]+id=["'](__next|root|app)["'][^>]*>\s*<\/\1>/i.test(body);

    const hasHydrationData =
      lower.includes('__next_data__') ||
      lower.includes('__next_f') ||
      lower.includes('window.__initial_state__') ||
      lower.includes('window.__apollo_state__') ||
      lower.includes('data-reactroot');

    const asksForJavascript =
      lower.includes('please enable javascript') ||
      lower.includes('enable javascript to run this app') ||
      lower.includes('you need to enable javascript');

    const hasLoadingHints =
      /\b(loading|please wait|spinner|initializing|fetching)\b/i.test(lower);

    const textLength = textOnly.length;
    const htmlLength = lower.length;
    const contentDensity = textLength / Math.max(htmlLength, 1);

    const isMostlyScripts = scriptCount >= 5 && textLength < 500;

    const isSmallShellLike =
      htmlLength < 50_000 &&
      textLength < 500 &&
      contentDensity < 0.02;

    return (
      asksForJavascript ||
      hasEmptyAppMountNode ||
      hasHydrationData ||
      isMostlyScripts ||
      isSmallShellLike ||
      (hasLoadingHints && textLength < 1_000 && contentDensity < 0.05)
    );
  }

  private diagFromRenderedAttempt(
    doc: RAGDocument | null,
    bodyTextLengthHint: number,
    renderFailure: string | undefined,
    blockedSuspected: boolean | undefined,
    modeOk: string,
    modeFailed: string
  ): {
    doc: RAGDocument | null;
    diag?: { modeUsed: string; reason?: string; errorMessage?: string };
    bodyTextLengthHint?: number;
  } {
    if (blockedSuspected) {
      return {
        doc: null,
        diag: { modeUsed: modeFailed, reason: 'blocked_suspected' },
      };
    }
    if (renderFailure) {
      return {
        doc: null,
        diag: { modeUsed: modeFailed, reason: 'render_error', errorMessage: renderFailure },
      };
    }
    return {
      doc,
      diag: doc
        ? { modeUsed: modeOk }
        : { modeUsed: modeFailed, reason: 'too_small' },
      bodyTextLengthHint: doc ? undefined : bodyTextLengthHint,
    };
  }

  private async crawlPageSmart(
    url: string,
    config: SitemapConfig,
    timeout: number,
    ctx: {
      renderMode: boolean | 'auto';
      renderOptions: RenderOptions;
      minContentLength: number;
      dbg: ReturnType<WebRAGPlugin['createDebugCollector']>;
    }
  ): Promise<{
    doc: RAGDocument | null;
    diag?: { modeUsed: string; reason?: string; errorMessage?: string };
    bodyTextLengthHint?: number;
  }> {
    if (ctx.renderMode === true) {
      const { doc, bodyTextLengthHint, renderFailure, blockedSuspected } = await this.crawlPageRendered(
        url, config, timeout, ctx.renderOptions, ctx.dbg
      );
      return this.diagFromRenderedAttempt(
        doc,
        bodyTextLengthHint,
        renderFailure,
        blockedSuspected,
        'render_ok',
        'render_failed'
      );
    }

    // Try static first
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'SnapAgent-CMS-Crawler/1.0',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(timeout),
      });

      if (!response.ok) {
        // Heuristic: anti-bot pages often return 403/429/503
        const status = response.status;
        if (status === 403 || status === 429 || status === 503) {
          ctx.dbg.log('crawl.blocked', { url, status });
          return { doc: null, diag: { modeUsed: 'static_failed', reason: 'blocked_suspected' } };
        }
        throw new Error(`HTTP ${status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        return { doc: null, diag: { modeUsed: 'static_failed', reason: 'non_html' } };
      }

      const html = await response.text();
      const doc = this.extractDocumentFromHtml(url, html, config);
      const staticHint = !doc ? this.bodyTextLengthHint(html, config) : undefined;

      if (doc && doc.content.length >= ctx.minContentLength) {
        return { doc, diag: { modeUsed: 'static_ok' } };
      }

      // doc is null or too small
      if (ctx.renderMode === 'auto') {
        const shouldRender = this.looksLikeDynamicShell(html) || !doc || (doc.content.length < ctx.minContentLength);
        if (shouldRender) {
          ctx.dbg.log('crawl.renderFallback', {
            url,
            reason: !doc ? 'no_doc' : 'too_small',
            staticLength: doc?.content?.length ?? 0,
          });
          const {
            doc: rendered,
            bodyTextLengthHint: rHint,
            renderFailure,
            blockedSuspected,
          } = await this.crawlPageRendered(
            url, config, timeout, ctx.renderOptions, ctx.dbg
          );
          const mergedHint = rHint ?? staticHint;
          const fb = this.diagFromRenderedAttempt(
            rendered,
            mergedHint,
            renderFailure,
            blockedSuspected,
            'render_fallback_ok',
            'render_fallback_failed'
          );
          if (!rendered && (renderFailure || blockedSuspected)) {
            fb.bodyTextLengthHint = staticHint ?? rHint;
          }
          return fb;
        }
      }

      return {
        doc: null,
        diag: { modeUsed: 'static_failed', reason: 'too_small' },
        bodyTextLengthHint: staticHint,
      };
    } catch (e) {
      // Network/timeouts/etc.
      throw e;
    }
  }

  private async crawlPageRendered(
    url: string,
    config: SitemapConfig,
    timeout: number,
    renderOptions: RenderOptions,
    dbg: ReturnType<WebRAGPlugin['createDebugCollector']>
  ): Promise<{
    doc: RAGDocument | null;
    bodyTextLengthHint: number;
    renderFailure?: string;
    blockedSuspected?: boolean;
  }> {
    let playwright: any;
    try {
      // Avoid static TS module resolution (playwright is optional at runtime)
      // eslint-disable-next-line no-new-func
      playwright = await (Function('return import("playwright")')() as Promise<any>);
    } catch (e) {
      dbg.log('render.missingDependency', { url, error: 'playwright_not_installed' });
      throw new Error('playwright is not installed. Add it to dependencies to use crawlPageRendered().');
    }

    const waitUntil = renderOptions.waitUntil || 'domcontentloaded';
    const waitForSelector = renderOptions.waitForSelector;
    const scrollCfg = renderOptions.scroll || {};
    const doScroll = scrollCfg.enabled ?? false;
    const maxScrolls = scrollCfg.maxScrolls ?? 10;
    const scrollDelayMs = scrollCfg.scrollDelayMs ?? 750;
    const stableIterations = scrollCfg.stableIterations ?? 2;
    const postRenderDelayMs = renderOptions.postRenderDelayMs ?? 0;

    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil, timeout });
      if (waitForSelector) {
        await page.waitForSelector(waitForSelector, { timeout });
      }
      if (postRenderDelayMs > 0) {
        await page.waitForTimeout(postRenderDelayMs);
      }

      if (doScroll) {
        let stable = 0;
        let lastLen = 0;
        for (let i = 0; i < maxScrolls; i++) {
          const len = await page.evaluate("(document.body?.innerText || '').length");
          if (len <= lastLen + 20) stable++;
          else stable = 0;
          lastLen = len;
          if (stable >= stableIterations) break;

          await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
          await page.waitForTimeout(scrollDelayMs);
        }
      }

      const html = await page.content();
      const bodyTextLengthHint = this.bodyTextLengthHint(html, config);
      const doc = this.extractDocumentFromHtml(url, html, config);

      if (config.debug?.saveDir && config.debug?.enabled) {
        try {
          const saveDir = config.debug.saveDir;
          const safeId = this.urlToId(url) || 'page';
          const outDir = path.join(saveDir, safeId);
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, 'rendered.html'), html, 'utf8');
          fs.writeFileSync(path.join(outDir, 'extracted.txt'), doc?.content || '', 'utf8');
          fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(doc?.metadata || {}, null, 2), 'utf8');
        } catch (e) {
          dbg.log('debug.saveFailed', { url, error: e instanceof Error ? e.message : 'save_failed' });
        }
      }

      return { doc, bodyTextLengthHint };
    } catch (e: any) {
      const msg = String(e?.message || e || 'render_failed');
      const lower = msg.toLowerCase();
      if (lower.includes('captcha') || lower.includes('access denied')) {
        dbg.log('render.blocked', { url, error: msg });
        return { doc: null, bodyTextLengthHint: 0, blockedSuspected: true };
      }
      dbg.log('render.error', { url, error: msg });
      return { doc: null, bodyTextLengthHint: 0, renderFailure: msg };
    } finally {
      await browser.close();
    }
  }

  private async discoverSitemaps(
    baseUrl: string,
    timeout: number,
    dbg: ReturnType<WebRAGPlugin['createDebugCollector']>
  ): Promise<string[]> {
    const base = new URL(baseUrl);
    const robotsUrl = new URL('/robots.txt', base).toString();

    const found = new Set<string>();
    try {
      const res = await fetch(robotsUrl, {
        headers: { 'User-Agent': 'SnapAgent-CMS-Crawler/1.0' },
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) {
        const txt = await res.text();
        const rx = /^sitemap:\s*(\S+)/gim;
        let m: RegExpExecArray | null;
        while ((m = rx.exec(txt)) !== null) {
          const sm = m[1].trim();
          if (sm.startsWith('http')) found.add(sm);
        }
        dbg.log('discovery.robots', { robotsUrl, ok: true, sitemapCount: found.size });
      } else {
        dbg.log('discovery.robots', { robotsUrl, ok: false, status: res.status });
      }
    } catch (e) {
      dbg.log('discovery.robots', { robotsUrl, ok: false, error: e instanceof Error ? e.message : 'failed' });
    }

    if (found.size === 0) {
      const candidates = [
        '/sitemap.xml',
        '/sitemap_index.xml',
        '/sitemap-index.xml',
        '/wp-sitemap.xml',
      ].map(p => new URL(p, base).toString());
      candidates.forEach(c => found.add(c));
      dbg.log('discovery.sitemapCandidates', { count: candidates.length });
    }

    return Array.from(found);
  }

  private createDebugCollector(debug?: DebugOptions) {
    const enabled = !!debug?.enabled;
    const level = debug?.level || 'summary';
    const maxPerUrlLogs = debug?.maxPerUrlLogs ?? 200;
    const entries: Array<{ ts: string; event: string; data?: any }> = [];

    return {
      log: (event: string, data?: any) => {
        if (!enabled) return;
        if (level === 'summary' && !event.startsWith('discovery.') && !event.startsWith('crawl.')) return;
        if (entries.length >= maxPerUrlLogs) return;
        entries.push({ ts: new Date().toISOString(), event, data });
      },
      summary: () => (enabled ? { enabled, level, entries } : undefined),
    };
  }

  /**
   * Clean extracted text content
   */
  private cleanContent(text: string): string {
    return text
      .replace(/\s+/g, ' ')           // Collapse whitespace
      .replace(/\n\s*\n/g, '\n\n')    // Normalize paragraph breaks
      .replace(/\t/g, ' ')            // Replace tabs
      .trim();
  }

  /**
   * Convert URL to a stable document ID
   */
  private urlToId(url: string): string {
    return url
      .replace(/^https?:\/\//, '')
      .replace(/[^a-zA-Z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 100);
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================================================
  // RSS/Atom Feed Ingestion
  // ============================================================================

  /**
   * Ingest content from an RSS or Atom feed
   * 
   * @example
   * ```typescript
   * // Simple RSS ingestion
   * await plugin.ingestFromRSS({
   *   feedUrl: 'https://myblog.com/feed/',
   * });
   * 
   * // Fetch full page content for each item
   * await plugin.ingestFromRSS({
   *   feedUrl: 'https://myblog.com/feed/',
   *   fetchFullContent: true,
   *   contentSelector: 'article',
   * });
   * ```
   */
  async ingestFromRSS(
    config: RSSConfig,
    options?: IngestOptions
  ): Promise<CrawlResult> {
    try {
      const response = await fetch(config.feedUrl, {
        headers: { 'User-Agent': 'SnapAgent-CMS-Crawler/1.0' },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        return {
          success: false,
          indexed: 0,
          failed: 1,
          urlsCrawled: 0,
          urlsSkipped: 0,
          urlsFailed: 1,
          crawledAt: new Date(),
          errors: [{ id: config.feedUrl, error: `HTTP ${response.status}` }],
        };
      }

      const xml = await response.text();
      const items = this.parseRSSFeed(xml);

      if (items.length === 0) {
        return {
          success: true,
          indexed: 0,
          failed: 0,
          urlsCrawled: 0,
          urlsSkipped: 0,
          urlsFailed: 0,
          crawledAt: new Date(),
        };
      }

      const documents: RAGDocument[] = [];
      const type = config.type || 'post';
      let urlsCrawled = 0;
      let urlsFailed = 0;
      const errors: Array<{ id: string; error: string }> = [];

      for (const item of items) {
        try {
          let content = item.content || item.description || '';

          // Optionally fetch full content from the page
          if (config.fetchFullContent && item.link) {
            try {
              const doc = await this.crawlPage(item.link, {
                contentSelector: config.contentSelector,
                defaultType: type,
              }, 30000);
              if (doc) {
                content = doc.content;
              }
              urlsCrawled++;
            } catch (error) {
              urlsFailed++;
              // Fall back to feed content
            }
          }

          // Strip HTML from content if present
          content = this.stripHtml(content);

          if (content.length < 50) continue;

          documents.push({
            id: this.urlToId(item.link || item.guid || `rss-${documents.length}`),
            content,
            metadata: {
              type,
              title: item.title,
              url: item.link,
              publishedAt: item.pubDate,
              author: item.author,
              categories: item.categories,
              ...config.metadata,
            },
          });
        } catch (error) {
          errors.push({
            id: item.link || 'unknown',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      // Ingest documents
      let indexed = 0;
      if (documents.length > 0) {
        const ingestResult = await this.ingest(documents, options);
        indexed = ingestResult.indexed;
      }

      return {
        success: errors.length === 0,
        indexed,
        failed: errors.length,
        urlsCrawled,
        urlsSkipped: 0,
        urlsFailed,
        crawledAt: new Date(),
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      return {
        success: false,
        indexed: 0,
        failed: 1,
        urlsCrawled: 0,
        urlsSkipped: 0,
        urlsFailed: 0,
        crawledAt: new Date(),
        errors: [{
          id: config.feedUrl,
          error: error instanceof Error ? error.message : 'Unknown error',
        }],
      };
    }
  }

  /**
   * Parse RSS/Atom feed XML
   */
  private parseRSSFeed(xml: string): Array<{
    title?: string;
    link?: string;
    guid?: string;
    description?: string;
    content?: string;
    pubDate?: string;
    author?: string;
    categories?: string[];
  }> {
    const items: Array<any> = [];

    // Detect feed type
    const isAtom = xml.includes('<feed') && xml.includes('xmlns="http://www.w3.org/2005/Atom"');

    if (isAtom) {
      // Parse Atom feed
      const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
      let match;
      while ((match = entryRegex.exec(xml)) !== null) {
        const entry = match[1];
        items.push({
          title: this.extractXmlValue(entry, 'title'),
          link: this.extractAtomLink(entry),
          guid: this.extractXmlValue(entry, 'id'),
          content: this.extractXmlValue(entry, 'content') || this.extractXmlValue(entry, 'summary'),
          pubDate: this.extractXmlValue(entry, 'published') || this.extractXmlValue(entry, 'updated'),
          author: this.extractXmlValue(entry, 'name'), // Inside <author>
          categories: this.extractXmlValues(entry, 'category', 'term'),
        });
      }
    } else {
      // Parse RSS feed
      const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
      let match;
      while ((match = itemRegex.exec(xml)) !== null) {
        const item = match[1];
        items.push({
          title: this.extractXmlValue(item, 'title'),
          link: this.extractXmlValue(item, 'link'),
          guid: this.extractXmlValue(item, 'guid'),
          description: this.extractXmlValue(item, 'description'),
          content: this.extractXmlValue(item, 'content:encoded') || this.extractXmlValue(item, 'content'),
          pubDate: this.extractXmlValue(item, 'pubDate'),
          author: this.extractXmlValue(item, 'author') || this.extractXmlValue(item, 'dc:creator'),
          categories: this.extractXmlValues(item, 'category'),
        });
      }
    }

    return items;
  }

  /**
   * Extract a single value from XML
   */
  private extractXmlValue(xml: string, tag: string): string | undefined {
    // Handle CDATA
    const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
    const cdataMatch = xml.match(cdataRegex);
    if (cdataMatch) {
      return cdataMatch[1].trim();
    }

    // Regular tag
    const regex = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : undefined;
  }

  /**
   * Extract multiple values from XML
   */
  private extractXmlValues(xml: string, tag: string, attr?: string): string[] {
    const values: string[] = [];

    if (attr) {
      // Extract from attribute (e.g., <category term="value"/>)
      const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*/?>`, 'gi');
      let match;
      while ((match = regex.exec(xml)) !== null) {
        values.push(match[1]);
      }
    } else {
      // Extract from content
      const regex = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'gi');
      let match;
      while ((match = regex.exec(xml)) !== null) {
        values.push(match[1].trim());
      }
    }

    return values;
  }

  /**
   * Extract link from Atom entry
   */
  private extractAtomLink(entry: string): string | undefined {
    // Look for <link rel="alternate" href="..."/>
    const alternateMatch = entry.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i);
    if (alternateMatch) return alternateMatch[1];

    // Fall back to first link
    const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/i);
    return linkMatch ? linkMatch[1] : undefined;
  }

  /**
   * Strip HTML tags from content
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get cache statistics
   */
  getCacheStats(): { hits: number; misses: number; hitRate: string } {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    const hitRate = total > 0 ? (this.cacheStats.hits / total).toFixed(3) : '0.000';
    return { ...this.cacheStats, hitRate };
  }

  /**
   * Clear embedding cache
   */
  clearCache(): void {
    this.embeddingCache.clear();
    this.cacheStats = { hits: 0, misses: 0 };
  }

  /**
   * Get plugin configuration (for persistence)
   */
  getConfig(): Record<string, any> {
    return {
      name: this.name,
      mongoUri: '${MONGODB_URI}',  // Reference env var
      dbName: this.config.dbName,
      collection: this.config.collection,
      openaiApiKey: '${OPENAI_API_KEY}',  // Reference env var
      embeddingModel: this.config.embeddingModel,
      tenantId: this.config.tenantId,
      vectorIndexName: this.config.vectorIndexName,
      numCandidates: this.config.numCandidates,
      limit: this.config.limit,
      minScore: this.config.minScore,
      filterableFields: this.config.filterableFields,
      typeBoosts: this.config.typeBoosts,
      recencyBoost: this.config.recencyBoost,
      priority: this.priority,
    };
  }
}

