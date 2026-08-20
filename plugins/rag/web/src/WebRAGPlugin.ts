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
import { createHash } from 'node:crypto';
import {
  bodyTextLengthHint as htmlBodyTextLengthHint,
  extractPageFromHtml,
  urlToDocumentId,
} from './htmlPageExtract';
import { runWithConcurrency } from './concurrency';

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
  BulkProgressCallback,
  BulkProgressUpdate,
  CrawlProgressCallback,
  CrawlProgressUpdate,
  CrawlPageEvent,
} from './types';

function bulkOpCurrentUrl(op: BulkOperation): string | undefined {
  const meta = op.document?.metadata as { url?: string; source?: string } | undefined;
  if (typeof meta?.url === 'string' && meta.url.trim()) return meta.url.trim();
  if (typeof meta?.source === 'string' && meta.source.trim()) return meta.source.trim();
  return undefined;
}

/** UI bulk URL panel: metadata.type url + http(s) URL → crawl page instead of indexing literal input text. */
function isUrlListingInsert(document: { metadata?: Record<string, unknown> }): boolean {
  const meta = document.metadata;
  if (meta?.type !== 'url') return false;
  const url = typeof meta.url === 'string' ? meta.url.trim() : '';
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Version of the content-hash normalization. Bump this if `normalizeForHash` changes (or to force a
 * one-time re-vectorization of everything): a ledger row whose `hashAlgo` differs is treated as
 * changed. `contentHash` values are only comparable within the same version.
 */
const HASH_ALGO_VERSION = 'sha256-v1';

/** El ámbito de una operación de ledger. `null` es el ámbito legacy, no "cualquiera". */
function ledgerScope(sourceId: string | undefined): { sourceId: string | null } {
  return { sourceId: sourceId ?? null };
}

/**
 * Normalize page text before hashing so non-semantic differences (whitespace, line endings, Unicode
 * composition) don't register as content changes. Deliberately does NOT lowercase or strip
 * numbers/symbols — a price/stock change (which lives inside the content) must move the hash.
 */
function normalizeForHash(content: string): string {
  return content
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')        // CRLF / CR → LF
    .replace(/[ \t]+/g, ' ')        // collapse intra-line runs of spaces/tabs
    .replace(/ *\n */g, '\n')       // trim each line
    .replace(/\n{3,}/g, '\n\n')     // collapse 3+ blank lines
    .trim();
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(normalizeForHash(content)).digest('hex');
}

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
  /**
   * Single in-flight connection promise. Both `client` and `db` are only assigned AFTER `connect()`
   * resolves, so concurrent callers can never observe a non-null `client` with a still-null `db`
   * (the race that surfaced under agentic retrieval's parallel tool calls). All connection users
   * await this same promise.
   */
  private connectPromise: Promise<Db> | null = null;
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
      embeddingBatchSize: 100,
      embeddingConcurrency: 4,
      ...config,
    };
    this.priority = config.priority ?? 100;
    this.openai = new OpenAI({ apiKey: config.openaiApiKey });
  }

  // ============================================================================
  // MongoDB Connection
  // ============================================================================

  /**
   * Lazily open (and memoize) the Mongo connection. Concurrent callers share one in-flight promise
   * instead of each racing to create a client — and `client`/`db` are assigned only after `connect()`
   * resolves, so no caller ever sees a half-initialized state. On failure the cached promise is
   * cleared so the next call retries a fresh connection.
   */
  private async connect(): Promise<Db> {
    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        const client = new MongoClient(this.config.mongoUri);
        await client.connect();
        this.client = client;
        this.db = client.db(this.config.dbName);
        return this.db;
      })().catch((err) => {
        this.connectPromise = null;
        throw err;
      });
    }
    return this.connectPromise;
  }

  private async getCollection(): Promise<Collection<StoredWebDocument>> {
    const db = await this.connect();
    return db.collection<StoredWebDocument>(this.config.collection!);
  }

  private ledgerIndexesEnsured = false;

  private async getLedgerCollection(): Promise<Collection<CrawlLedgerDocument>> {
    const db = await this.connect();
    const name = this.config.crawlLedger?.collection ?? 'web_crawl_ledger';
    const col = db.collection<CrawlLedgerDocument>(name);
    if (!this.ledgerIndexesEnsured) {
      this.ledgerIndexesEnsured = true;
      // La identidad de una fila de ledger incluye el source. Sin él, dos sources del mismo agente
      // que compartan una URL comparten una fila: cada upsert le pisa al otro el sourceId y el
      // ingestionId, y el diff de re-crawl deja de pertenecer a un corpus.
      //
      // La migración de la clave vieja la hace el server; acá sólo se declara la nueva. Ver
      // "Orden entre repos" en el plan: este paquete tiene que publicarse ANTES de esa migración,
      // porque si no el SDK viejo vuelve a crear el índice sin sourceId y la deshace.
      await col.createIndex(
        { tenantId: 1, agentId: 1, sourceId: 1, urlNormalized: 1 },
        { unique: true },
      );
      await col.createIndex({ tenantId: 1, agentId: 1, ingestionId: 1, lastCrawledAt: -1 });
    }
    return col;
  }

  /**
   * List recent crawl ledger rows (for dashboards / pagination in the front).
   */
  async listCrawlLedger(options: {
    agentId?: string;
    domain?: string;
    ingestionId?: string;
    status?: CrawlLedgerStatus;
    limit?: number;
    skip?: number;
  } = {}): Promise<CrawlLedgerDocument[]> {
    const col = await this.getLedgerCollection();
    const filter: Record<string, unknown> = { tenantId: this.config.tenantId };
    filter.agentId = options.agentId ?? 'shared';
    if (options.domain) filter.domain = options.domain;
    if (options.ingestionId) filter.ingestionId = options.ingestionId;
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
    agentId: string,
    sourceId: string | undefined,
  ): Promise<CrawlLedgerDocument | null> {
    const col = await this.getLedgerCollection();
    return col.findOne({
      tenantId: this.config.tenantId,
      agentId,
      urlNormalized,
      ...ledgerScope(sourceId),
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
    ingestionId?: string;
    sourceId?: string;
    status: CrawlLedgerStatus;
    doc?: RAGDocument | null;
    diag?: { modeUsed?: string; reason?: string; errorMessage?: string };
    errorMessage?: string;
    title?: string | null;
    docId?: string | null;
    contentLength?: number | null;
    /** sha256(normalizeForHash(content)); only written for indexed pages, never nulled otherwise. */
    contentHash?: string;
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
    if (params.ingestionId) {
      $set.ingestionId = params.ingestionId;
    }
    if (params.sourceId) {
      $set.sourceId = params.sourceId;
    }
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
      // Only stamp the content hash on a successful index, and never null it elsewhere — preserving
      // it across a transient error/too_small avoids a needless re-embed on the next good crawl.
      if (params.status === 'indexed' && params.contentHash) {
        $set.contentHash = params.contentHash;
        $set.hashAlgo = HASH_ALGO_VERSION;
      }
    } else {
      $set.modeUsed = params.diag?.modeUsed;
      $set.contentLength = params.contentLength ?? null;
      $set.title = params.title ?? null;
      $set.docId = params.docId ?? null;
    }
    await col.updateOne(
      {
        tenantId: this.config.tenantId,
        agentId: params.agentId,
        urlNormalized: params.urlNormalized,
        ...ledgerScope(params.sourceId),
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
      this.connectPromise = null;
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
      /** Per-call cap on returned docs, overriding the configured `limit` (clamped to [1, 100]). */
      limit?: number;
    } = {}
  ): Promise<RAGContext> {
    const queryVector = await this.generateEmbedding(message);

    // Per-call `limit` (e.g. a deeper card pool, or 1 for a focused drill-down) overrides the
    // configured default. Clamped to [1, 100].
    const effectiveLimit =
      typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Math.min(Math.max(Math.floor(options.limit), 1), 100)
        : this.config.limit!;

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
      limit: effectiveLimit,
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

    // Sort by final score and apply the resolved limit (computed above).
    scoredResults.sort((a, b) => b.score - a.score);
    scoredResults = scoredResults.slice(0, effectiveLimit);

    // Format context
    const content = this.formatResultsToContext(scoredResults);

    return {
      content,
      metadata: {
        plugin: this.name,
        contentCount: scoredResults.length,
        types: [...new Set(scoredResults.map(d => d.metadata.type))],
        // Expose the FULL retrieved set (already bounded by effectiveLimit above), not a hardcoded
        // 16. The host card pipeline filters/reranks this pool, so capping it here starved recall for
        // minority attributes (e.g. "manga larga" when short-sleeve dominates the top 16).
        topResults: scoredResults.map(doc => ({
          id: doc.id,
          type: doc.metadata.type,
          title: doc.metadata.title,
          url: doc.metadata.url,
          imageUrl: doc.metadata.imageUrl,
          description: doc.metadata.description,
          cardEligible: doc.metadata.cardEligible,
          cardPriority: doc.metadata.cardPriority,
          displayTitle: doc.metadata.displayTitle,
          displayDescription: doc.metadata.displayDescription,
          displayImageUrl: doc.metadata.displayImageUrl,
          ...(doc.metadata.price != null ? { price: doc.metadata.price } : {}),
          ...(doc.metadata.currency ? { currency: doc.metadata.currency } : {}),
          ...(doc.metadata.availability ? { availability: doc.metadata.availability } : {}),
          ...(doc.metadata.colors ? { colors: doc.metadata.colors } : {}),
          ...(doc.metadata.colorImages ? { colorImages: doc.metadata.colorImages } : {}),
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
    /** Target result count (defaults to config.limit). Fetches 2× for post-filter headroom. */
    limit?: number;
  }): Promise<Array<StoredWebDocument & { score: number }>> {
    const collection = await this.getCollection();

    // Fetch 2× the target for post-filtering (minScore), and ensure numCandidates covers it.
    const fetchLimit = (options.limit ?? this.config.limit!) * 2;
    const numCandidates = Math.max(this.config.numCandidates ?? 100, fetchLimit);

    const pipeline: any[] = [
      {
        $vectorSearch: {
          index: this.config.vectorIndexName,
          path: 'embedding',
          queryVector: options.queryVector,
          numCandidates,
          limit: fetchLimit,
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

    // Exclude the embedding vector from the payload: retrieveContext only reads content/metadata/score,
    // never doc.embedding. Without this, each of the fetchLimit (2×limit) matches ships its 1536-float
    // vector (~1MB total for limit=40) across the Atlas→app network — the dominant cost of retrieval.
    // Pure exclusion ({ embedding: 0 }) keeps every other field intact.
    pipeline.push({ $project: { embedding: 0 } });

    pipeline.push({ $limit: fetchLimit });

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

    const jobs = subBatches.map((batch) => async (): Promise<number[][]> => {
      const response = await this.openai.embeddings.create({
        model: this.config.embeddingModel!,
        input: batch,
      });
      // OpenAI returns one item per input; sort by index to be safe.
      return [...response.data]
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    });

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

    const onCrawlProgress = (options as { metadata?: Record<string, unknown> } | undefined)
      ?.metadata?.onCrawlProgress as CrawlProgressCallback | undefined;
    const indexingTotal = documents.length;
    const chunkPlan = documents.map((doc) => this.chunkContent(doc.content));
    const chunksTotal = chunkPlan.reduce((sum, chunks) => sum + chunks.length, 0);
    let chunksProcessed = 0;

    if (onCrawlProgress && indexingTotal > 0) {
      this.emitCrawlProgress(
        { metadata: options?.metadata },
        {
          phase: 'indexing',
          urlsScheduled: indexingTotal,
          pagesProcessed: 0,
          chunksTotal,
          chunksProcessed: 0,
        },
      );
    }

    const failedDocIds = new Set<string>();
    const markFailed = (docId: string, error: unknown) => {
      if (failedDocIds.has(docId)) return;
      failedDocIds.add(docId);
      errors.push({
        id: docId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    };

    // Flatten every chunk across all documents into a single work list so we can
    // embed them in batched, concurrent requests instead of one call per chunk.
    type FlatChunk = { docId: string; docIndex: number; storedDoc: any; content: string };
    const flat: FlatChunk[] = [];

    for (let docIndex = 0; docIndex < documents.length; docIndex++) {
      const doc = documents[docIndex];
      const chunks = chunkPlan[docIndex]!;
      const isChunked = chunks.length > 1;

      // Remove any previous chunks for this document before re-ingesting.
      //
      // Acotado por sourceId: `documentId` se deriva de la URL y NO es único entre sources del
      // mismo agente, así que sin este filtro dos sources que compartan una URL —o cuyos ids
      // colisionen al truncarse— se borran los chunks entre sí.
      //
      // Y corre SIEMPRE, no sólo cuando el documento quedó chunkeado: si una página pasó de
      // chunkeada a no-chunkeada, el borrado condicionado dejaba vivos los chunks viejos.
      //
      // Y borra por las DOS formas de id: un documento que antes cabía en un solo chunk se guardó
      // con `id: doc.id` y sin `documentId`; si ahora se chunkea, borrar sólo por `documentId`
      // deja vivo el singleton viejo y la página queda duplicada.
      const sourceId = doc.metadata?.sourceId;
      const scope = {
        tenantId: this.config.tenantId,
        agentId,
        // SIEMPRE presente. Omitirlo cuando falta no acota menos: no acota nada, y el borrado se
        // lleva puestos los chunks de otro source que comparta el id de documento.
        'metadata.sourceId': typeof sourceId === 'string' && sourceId ? sourceId : null,
      };
      try {
        await collection.deleteMany({
          ...scope,
          $or: [{ documentId: doc.id }, { id: doc.id }],
        });
      } catch (error) {
        markFailed(doc.id, error);
        continue;
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = isChunked ? `chunk-${doc.id}-${i}` : doc.id;
        const storedDoc: any = {
          id: chunkId,
          content: chunks[i],
          metadata: {
            type: doc.metadata?.type || 'content',
            ...doc.metadata,
          },
          tenantId: this.config.tenantId,
          agentId,
        };

        if (isChunked) {
          storedDoc.documentId = doc.id;
          storedDoc.chunkIndex = i;
        }

        flat.push({ docId: doc.id, docIndex, storedDoc, content: chunks[i] });
      }
    }

    // Process in macro-batches: embed AND persist each batch before moving on,
    // so crawl progress advances incrementally during the (slow) embedding work
    // instead of staying frozen until every embedding finishes and then jumping.
    const processedDocs = new Set<number>();
    const macroSize = Math.max(
      1,
      (this.config.embeddingBatchSize ?? 100) * (this.config.embeddingConcurrency ?? 4)
    );

    for (let start = 0; start < flat.length; start += macroSize) {
      const slice = flat
        .slice(start, start + macroSize)
        .filter((f) => !failedDocIds.has(f.docId));
      if (slice.length === 0) continue;

      // Embed this macro-batch (internally split into concurrent sub-batches).
      let embeddings: number[][];
      try {
        embeddings = await this.generateEmbeddingsBatch(slice.map((f) => f.content));
      } catch (error) {
        for (const f of slice) markFailed(f.docId, error);
        continue;
      }

      // Persist this macro-batch with a single bulkWrite.
      const ops = slice.map((f, i) => {
        f.storedDoc.embedding = embeddings[i];
        return {
          updateOne: {
            filter: { tenantId: this.config.tenantId, id: f.storedDoc.id, agentId },
            update: {
              $set: { ...f.storedDoc, updatedAt: new Date() },
              $setOnInsert: { createdAt: new Date() },
            },
            upsert: true,
          },
        };
      });

      try {
        await collection.bulkWrite(ops as any);
      } catch (error) {
        for (const f of slice) markFailed(f.docId, error);
        continue;
      }

      chunksProcessed += slice.length;
      for (const f of slice) processedDocs.add(f.docIndex);
      if (onCrawlProgress) {
        this.emitCrawlProgress(
          { metadata: options?.metadata },
          {
            phase: 'indexing',
            urlsScheduled: indexingTotal,
            pagesProcessed: processedDocs.size,
            chunksTotal,
            chunksProcessed,
          },
        );
      }
    }

    indexed = documents.length - failedDocIds.size;

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
    const opsTotal = operations.length;
    let opsDone = 0;

    const ingestOptions = options ?? {};
    this.emitBulkProgress(ingestOptions, {
      phase: 'processing',
      opsTotal,
      opsDone: 0,
    });

    for (const op of operations) {
      const currentUrl = bulkOpCurrentUrl(op);
      try {
        switch (op.type) {
          case 'insert':
            if (op.document) {
              if (isUrlListingInsert(op.document)) {
                const url = bulkOpCurrentUrl(op)!;
                const crawlResult = await this.ingestSinglePageFromUrl(
                  {
                    url,
                    metadata: {
                      ...(op.document.metadata ?? {}),
                      url,
                    },
                  },
                  ingestOptions,
                );
                if (crawlResult.indexed > 0) {
                  inserted++;
                } else {
                  failed++;
                  const err =
                    crawlResult.errors?.[0]?.error ??
                    `Failed to crawl ${url}`;
                  errors.push({
                    id: op.id,
                    operation: op.type,
                    error: err,
                  });
                }
              } else {
                await this.ingest([op.document], ingestOptions);
                inserted++;
              }
            }
            break;
          case 'update':
            if (op.document) {
              await this.update(op.id, op.document, ingestOptions);
              updated++;
            }
            break;
          case 'delete':
            const count = await this.delete(op.id, ingestOptions);
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
      } finally {
        opsDone++;
        this.emitBulkProgress(ingestOptions, {
          phase: 'processing',
          opsTotal,
          opsDone,
          currentOpType: op.type,
          ...(currentUrl ? { currentUrl } : {}),
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

    this.emitCrawlProgress(config, { phase: 'discovering', urlsDiscovered: 0 });

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

        this.emitCrawlProgress(config, {
          phase: 'discovering',
          urlsDiscovered: filteredUrls.length,
        });

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
      this.emitCrawlProgress(config, {
        phase: 'discovering',
        urlsDiscovered: urlsToCrawl.length,
      });
    }

    this.emitCrawlProgress(config, {
      phase: 'crawling',
      urlsDiscovered: urlsToCrawl.length,
      urlsScheduled: urlsToCrawl.length,
    });

    const result = await this.crawlUrls(urlsToCrawl, {
      contentSelector: config.contentSelector,
      titleSelector: config.titleSelector,
      removeSelectors: config.removeSelectors,
      extractVariantMetadata: config.extractVariantMetadata,
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
      extractLinks: config.extractLinks,
      maxLinksPerPage: config.maxLinksPerPage,
    }, options);

    return {
      ...result,
      urlsSkipped,
      /** URLs selected for this crawl (≤ maxPages); use for progress UI denominador. */
      urlsScheduled: urlsToCrawl.length,
      crawledAt: new Date(),
      metadata: {
        ...(result.metadata || {}),
        urlsScheduled: urlsToCrawl.length,
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
   * When `config.extractLinks` is set, parse same-origin internal links from a page's HTML so the
   * caller can drive a resumable recursive (BFS) crawl without a separate discovery fetch. Returns
   * undefined when disabled or on any parse error (link extraction must never fail a crawl).
   */
  private extractLinksIfEnabled(
    url: string,
    html: string,
    config: SitemapConfig
  ): string[] | undefined {
    if (!config.extractLinks) return undefined;
    try {
      const base = new URL(url);
      const links = this.extractInternalLinks(html, base, config.stripQueryParams ?? false);
      const cap = config.maxLinksPerPage ?? 200;
      return links.length > cap ? links.slice(0, cap) : links;
    } catch {
      return undefined;
    }
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
      extractVariantMetadata: config.extractVariantMetadata,
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
      extractLinks: config.extractLinks,
      maxLinksPerPage: config.maxLinksPerPage,
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
      extractVariantMetadata: config.extractVariantMetadata,
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
    const ingestionId =
      typeof config.metadata?.ingestionId === 'string' && config.metadata.ingestionId.trim()
        ? config.metadata.ingestionId.trim()
        : undefined;
    const sourceId =
      typeof config.metadata?.sourceId === 'string' && config.metadata.sourceId.trim()
        ? config.metadata.sourceId.trim()
        : undefined;

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
      // Content-hash change detection (distinct from ledgerSkipped, which is the pre-fetch TTL skip).
      added: 0,
      changed: 0,
      unchanged: 0,
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
          this.emitCrawlPage(config, { url, event: 'start' });

          // Fetch the ledger row once: needed both for the pre-fetch TTL skip and for the
          // post-crawl content-hash compare (the latter applies even under forceRecrawl).
          const ledgerEntry = ledgerOpts
            ? await this.findLedgerEntry(urlNormalized, agentId, sourceId)
            : null;

          // Pre-fetch TTL gate — bypassed entirely under forceRecrawl.
          if (
            ledgerOpts &&
            !forceRecrawl &&
            this.shouldSkipLedger(
              ledgerEntry,
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
              skippedReason: `fresh:${ledgerEntry?.lastStatus}`,
              contentLength: ledgerEntry?.contentLength,
              title: ledgerEntry?.title,
              docId: ledgerEntry?.docId,
            });
            dbg.log('crawl.ledgerSkip', { url, urlNormalized, lastStatus: ledgerEntry?.lastStatus });
            await this.upsertLedgerRecord({
              url,
              urlNormalized,
              agentId,
              ingestionId,
              sourceId,
              status: 'skipped_ledger',
              title: ledgerEntry?.title,
              docId: ledgerEntry?.docId,
              contentLength: ledgerEntry?.contentLength,
            });
            this.emitCrawlPage(config, { url, event: 'done', status: 'skipped_ledger' });
            return { kind: 'ledger_skip' as const, url };
          }

          try {
            const { doc, diag, bodyTextLengthHint, links } = await this.crawlPageSmart(url, config, timeout, {
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

            // Content-hash change detection: only for indexable pages with the ledger enabled.
            if (ledgerOpts && doc && crawlSt === 'indexed') {
              const newHash = computeContentHash(doc.content);
              const isUnchanged =
                ledgerEntry?.contentHash === newHash &&
                ledgerEntry?.hashAlgo === HASH_ALGO_VERSION &&
                ledgerEntry?.lastStatus === 'indexed';

              if (isUnchanged) {
                // Refresh the ledger (lastCrawledAt/ingestionId/sourceId) but keep contentHash, and
                // skip re-embedding. Still surface `links` so the caller's BFS keeps discovering URLs.
                await this.upsertLedgerRecord({
                  url,
                  urlNormalized,
                  agentId,
                  ingestionId,
                  sourceId,
                  status: crawlSt,
                  doc,
                  diag,
                  contentHash: newHash,
                });
                counters.unchanged++;
                this.pushPageStatus(pageStatuses, maxStatuses, {
                  url,
                  urlNormalized,
                  status: crawlSt,
                  modeUsed: diag?.modeUsed,
                  contentLength: doc.content.length,
                  bodyTextLengthHint,
                  title: doc.metadata?.title,
                  docId: doc.id,
                  changeStatus: 'unchanged',
                  contentHash: newHash,
                  ...(links ? { links } : {}),
                });
                this.emitCrawlPage(config, { url, event: 'done', status: crawlSt });
                return { kind: 'unchanged' as const, doc, url };
              }

              // New page (no prior hash) or genuinely changed → re-embed.
              const changeStatus = ledgerEntry?.contentHash ? 'changed' : 'added';
              if (changeStatus === 'changed') counters.changed++;
              else counters.added++;
              await this.upsertLedgerRecord({
                url,
                urlNormalized,
                agentId,
                ingestionId,
                sourceId,
                status: crawlSt,
                doc,
                diag,
                contentHash: newHash,
              });
              this.pushPageStatus(pageStatuses, maxStatuses, {
                url,
                urlNormalized,
                status: crawlSt,
                modeUsed: diag?.modeUsed,
                contentLength: doc.content.length,
                bodyTextLengthHint,
                title: doc.metadata?.title,
                docId: doc.id,
                error: diag?.errorMessage,
                changeStatus,
                contentHash: newHash,
                ...(links ? { links } : {}),
              });
              this.emitCrawlPage(config, {
                url,
                event: 'done',
                status: crawlSt,
                error: diag?.errorMessage,
              });
              return { kind: 'doc' as const, doc, url };
            }

            // Non-indexable pages (too_small / non_html / blocked / error-without-throw): no hash.
            if (ledgerOpts) {
              await this.upsertLedgerRecord({
                url,
                urlNormalized,
                agentId,
                ingestionId,
                sourceId,
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
              ...(links ? { links } : {}),
            });

            this.emitCrawlPage(config, {
              url,
              event: 'done',
              status: crawlSt,
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
                ingestionId,
                sourceId,
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
            this.emitCrawlPage(config, { url, event: 'done', status: 'error', error: msg });
            throw { url, error };
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const v = result.value;
          // Pre-fetch TTL skip: nothing crawled.
          if (v && typeof v === 'object' && 'kind' in v && v.kind === 'ledger_skip') {
            continue;
          }
          // Content unchanged: crawled (so its links already fed the frontier via pageStatuses) but
          // NOT pushed to `documents`, so it won't be re-embedded. Counts as crawled coverage.
          if (v && typeof v === 'object' && 'kind' in v && v.kind === 'unchanged') {
            urlsCrawled++;
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

      this.emitCrawlProgress(config, {
        phase: 'crawling',
        urlsScheduled: uniqueUrls.length,
        pagesProcessed: Math.min(i + batch.length, uniqueUrls.length),
      });

      // Delay between batches
      if (i + concurrency < uniqueUrls.length) {
        await this.delay(delayMs);
      }
    }

    // Ingest collected documents (embeddings → web_content; progress phase `indexing`)
    if (documents.length > 0) {
      const ingestResult = await this.ingest(documents, {
        ...options,
        metadata: {
          ...((options as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {}),
          onCrawlProgress: config.metadata?.onCrawlProgress,
        },
      });
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

  private bodyTextLengthHint(html: string, config: SitemapConfig): number {
    return htmlBodyTextLengthHint(html, config);
  }

  private extractDocumentFromHtml(url: string, html: string, config: SitemapConfig): RAGDocument | null {
    const extracted = extractPageFromHtml(url, html, config);
    if (!extracted.indexable) return null;

    return {
      id: extracted.id,
      content: extracted.content,
      metadata: extracted.metadata as RAGDocument['metadata'],
    };
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
    modeFailed: string,
    links?: string[]
  ): {
    doc: RAGDocument | null;
    diag?: { modeUsed: string; reason?: string; errorMessage?: string };
    bodyTextLengthHint?: number;
    links?: string[];
  } {
    if (blockedSuspected) {
      return {
        doc: null,
        diag: { modeUsed: modeFailed, reason: 'blocked_suspected' },
        links,
      };
    }
    if (renderFailure) {
      return {
        doc: null,
        diag: { modeUsed: modeFailed, reason: 'render_error', errorMessage: renderFailure },
        links,
      };
    }
    return {
      doc,
      diag: doc
        ? { modeUsed: modeOk }
        : { modeUsed: modeFailed, reason: 'too_small' },
      bodyTextLengthHint: doc ? undefined : bodyTextLengthHint,
      links,
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
    links?: string[];
  }> {
    if (ctx.renderMode === true) {
      const { doc, bodyTextLengthHint, renderFailure, blockedSuspected, links } =
        await this.crawlPageRendered(url, config, timeout, ctx.renderOptions, ctx.dbg);
      return this.diagFromRenderedAttempt(
        doc,
        bodyTextLengthHint,
        renderFailure,
        blockedSuspected,
        'render_ok',
        'render_failed',
        links
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
      const staticLinks = this.extractLinksIfEnabled(url, html, config);

      if (doc && doc.content.length >= ctx.minContentLength) {
        return { doc, diag: { modeUsed: 'static_ok' }, links: staticLinks };
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
            links: renderedLinks,
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
            'render_fallback_failed',
            // Prefer links from the rendered DOM; fall back to the static HTML's links.
            renderedLinks ?? staticLinks
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
        links: staticLinks,
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
    links?: string[];
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
      // Links from the rendered DOM include JS-injected anchors a static fetch would miss.
      const links = this.extractLinksIfEnabled(url, html, config);

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

      return { doc, bodyTextLengthHint, links };
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

  private emitBulkProgress(
    options: IngestOptions | undefined,
    update: BulkProgressUpdate,
  ): void {
    const fn = (options as { metadata?: Record<string, unknown> } | undefined)?.metadata
      ?.onBulkProgress as BulkProgressCallback | undefined;
    if (!fn) return;
    try {
      fn(update);
    } catch {
      /* progress hook must not abort bulk */
    }
  }

  private emitCrawlProgress(
    config: { metadata?: Record<string, unknown> },
    update: CrawlProgressUpdate,
  ): void {
    const fn = config.metadata?.onCrawlProgress as CrawlProgressCallback | undefined;
    if (!fn) return;
    try {
      fn(update);
    } catch {
      /* progress hook must not abort ingest */
    }
  }

  private emitCrawlPage(
    config: { metadata?: Record<string, unknown> },
    event: CrawlPageEvent,
  ): void {
    const fn = config.metadata?.onCrawlPage as ((e: CrawlPageEvent) => void) | undefined;
    if (!fn) return;
    try {
      fn(event);
    } catch {
      /* page hook must not abort ingest */
    }
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
  private urlToId(url: string): string {
    return urlToDocumentId(url);
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
      crawlLedger: this.config.crawlLedger,
      priority: this.priority,
    };
  }
}
