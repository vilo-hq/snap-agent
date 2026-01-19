/**
 * CMS RAG Plugin
 * 
 * Schema-agnostic RAG plugin for any CMS content.
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

import type {
  CMSRAGConfig,
  CMSDocument,
  StoredCMSDocument,
  URLSource,
  CMSIngestResult,
  CMSURLIngestResult,
  DrupalConfig,
  WordPressConfig,
  SanityConfig,
  StrapiConfig,
  SitemapConfig,
  UrlListConfig,
  RSSConfig,
  CrawlResult,
} from './types';

// ============================================================================
// CMS RAG Plugin
// ============================================================================

export class CMSRAGPlugin implements RAGPlugin {
  name = 'cms-rag';
  type = 'rag' as const;
  priority: number;

  private config: CMSRAGConfig;
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private openai: OpenAI;

  // Embedding cache
  private embeddingCache = new Map<string, { value: number[]; timestamp: number }>();
  private cacheStats = { hits: 0, misses: 0 };

  constructor(config: CMSRAGConfig) {
    this.config = {
      collection: 'cms_content',
      embeddingModel: 'text-embedding-3-small',
      vectorIndexName: 'cms_vector_index',
      numCandidates: 100,
      limit: 10,
      minScore: 0.7,
      filterableFields: ['type'],
      ...config,
    };
    this.priority = config.priority ?? 100;
    this.openai = new OpenAI({ apiKey: config.openaiApiKey });
  }

  // ============================================================================
  // MongoDB Connection
  // ============================================================================

  private async getCollection(): Promise<Collection<StoredCMSDocument>> {
    if (!this.client) {
      this.client = new MongoClient(this.config.mongoUri);
      await this.client.connect();
      this.db = this.client.db(this.config.dbName);
    }
    return this.db!.collection<StoredCMSDocument>(this.config.collection!);
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

    // Flexible agent filtering: shared content (no agentId) + agent-specific
    if (options.agentId) {
      hardFilters.$or = [
        { agentId: { $exists: false } },
        { agentId: null },
        { agentId: options.agentId },
      ];
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
          score: doc.score,
        })),
      },
    };
  }

  /**
   * Format retrieved content for LLM context
   */
  private formatResultsToContext(docs: Array<StoredCMSDocument & { score: number }>): string {
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
  }): Promise<Array<StoredCMSDocument & { score: number }>> {
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

    return results as Array<StoredCMSDocument & { score: number }>;
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
    const batchSize = options?.batchSize ?? 10;

    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);

      // Generate embeddings
      const embeddings = await this.generateEmbeddingsBatch(
        batch.map(doc => doc.content)
      );

      // Prepare documents for storage (without createdAt - handled by $setOnInsert)
      const docsToStore = batch.map((doc, idx) => ({
        id: doc.id,
        content: doc.content,
        metadata: {
          type: doc.metadata?.type || 'content',
          ...doc.metadata,
        },
        tenantId: this.config.tenantId,
        ...(options?.agentId && { agentId: options.agentId }),
        embedding: embeddings[idx],
      }));

      // Upsert documents
      for (const doc of docsToStore) {
        try {
          const filter: any = {
            tenantId: this.config.tenantId,
            id: doc.id,
          };

          // Match by agentId if provided, otherwise shared content
          if (options?.agentId) {
            filter.agentId = options.agentId;
          } else {
            filter.agentId = { $exists: false };
          }

          await collection.updateOne(
            filter,
            {
              $set: { ...doc, updatedAt: new Date() },
              $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true }
          );
          indexed++;
        } catch (error) {
          errors.push({
            id: doc.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
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
   * Update a single document
   */
  async update(
    id: string,
    document: Partial<RAGDocument>,
    options?: IngestOptions
  ): Promise<void> {
    const collection = await this.getCollection();

    const update: any = { updatedAt: new Date() };

    if (document.content) {
      const embedding = await this.generateEmbedding(document.content);
      update.content = document.content;
      update.embedding = embedding;
    }

    if (document.metadata) {
      for (const [key, value] of Object.entries(document.metadata)) {
        update[`metadata.${key}`] = value;
      }
    }

    const filter: any = {
      tenantId: this.config.tenantId,
      id,
    };

    if (options?.agentId) {
      filter.agentId = options.agentId;
    } else {
      filter.agentId = { $exists: false };
    }

    await collection.updateOne(filter, { $set: update });
  }

  /**
   * Delete document(s) by ID
   */
  async delete(
    ids: string | string[],
    options?: IngestOptions
  ): Promise<number> {
    const collection = await this.getCollection();

    const idArray = Array.isArray(ids) ? ids : [ids];

    const filter: any = {
      tenantId: this.config.tenantId,
      id: { $in: idArray },
    };

    if (options?.agentId) {
      filter.agentId = options.agentId;
    } else {
      filter.agentId = { $exists: false };
    }

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
  ): Promise<CMSURLIngestResult> {
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
  ): Promise<CMSURLIngestResult[]> {
    const results: CMSURLIngestResult[] = [];

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
  ): Promise<CMSURLIngestResult[]> {
    const results: CMSURLIngestResult[] = [];
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
  ): Promise<CMSURLIngestResult[]> {
    const results: CMSURLIngestResult[] = [];
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
  ): Promise<CMSURLIngestResult[]> {
    const results: CMSURLIngestResult[] = [];
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

    let indexed = 0;
    let urlsCrawled = 0;
    let urlsFailed = 0;
    const errors: Array<{ id: string; error: string }> = [];
    const documents: RAGDocument[] = [];

    // Process URLs in batches for concurrency control
    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);

      const results = await Promise.allSettled(
        batch.map(async (url) => {
          try {
            const doc = await this.crawlPage(url, config, timeout);
            return doc;
          } catch (error) {
            throw { url, error };
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          documents.push(result.value);
          urlsCrawled++;
        } else if (result.status === 'rejected') {
          urlsFailed++;
          errors.push({
            id: result.reason.url || 'unknown',
            error: result.reason.error?.message || 'Failed to crawl',
          });
        }
      }

      // Delay between batches
      if (i + concurrency < urls.length) {
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
    const $ = cheerio.load(html);

    // Remove unwanted elements
    const removeSelectors = config.removeSelectors || [
      'script', 'style', 'nav', 'header', 'footer',
      '.sidebar', '.navigation', '.menu', '.comments',
      '[role="navigation"]', '[role="banner"]',
    ];
    removeSelectors.forEach(selector => $(selector).remove());

    // Extract title
    const titleSelector = config.titleSelector || 'h1, title';
    let title = $(titleSelector).first().text().trim();
    if (!title) {
      title = $('title').text().trim();
    }

    // Extract main content
    let content = '';
    const contentSelector = config.contentSelector || 'article, main, .content, .post-content, #content, [role="main"]';
    const mainContent = $(contentSelector).first();

    if (mainContent.length) {
      content = mainContent.text().trim();
    } else {
      // Fallback: get body text
      content = $('body').text().trim();
    }

    // Clean up content
    content = this.cleanContent(content);

    if (!content || content.length < 50) {
      return null; // Skip pages with too little content
    }

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

    // Generate a stable ID from URL
    const id = this.urlToId(url);

    return {
      id,
      content,
      metadata: {
        type,
        title,
        url,
        ...config.metadata,
      },
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

