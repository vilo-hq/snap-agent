// ============================================================================
// Web RAG Plugin Types
// Schema-agnostic content types for web sources
// ============================================================================

/**
 * Content document with minimal required fields and flexible metadata
 * 
 * Only three things are required:
 * - id: Unique identifier
 * - content: Text to embed and search
 * - metadata.type: Content classification (e.g., 'blog', 'page', 'project', 'team')
 * 
 * Everything else in metadata is pass-through - store any fields you need.
 */
export interface WebDocument {
  id: string;
  content: string;
  metadata: {
    type: string;  // Required: content type (e.g., 'blog', 'page', 'project')
    title?: string;
    url?: string;
    [key: string]: any;  // Any additional fields
  };
}

/**
 * Stored document with embedding and system fields
 */
export interface StoredWebDocument extends WebDocument {
  tenantId: string;
  agentId?: string;
  documentId?: string;   // Parent document ID (set when content is chunked)
  chunkIndex?: number;   // Chunk position within the parent document
  embedding: number[];
  createdAt: Date;
  updatedAt?: Date;
}

/**
 * Plugin configuration
 */
export interface WebRAGConfig {
  // MongoDB connection
  mongoUri: string;
  dbName: string;
  collection?: string;  // Default: 'web_content'

  // AI configuration
  openaiApiKey: string;
  embeddingModel?: string;  // Default: 'text-embedding-3-small'

  // Tenant isolation
  tenantId: string;

  // Search configuration
  vectorIndexName?: string;  // Default: 'web_vector_index'
  numCandidates?: number;    // Default: 100
  limit?: number;            // Default: 10
  minScore?: number;         // Default: 0.7

  // Filterable metadata fields (for MongoDB index optimization)
  filterableFields?: string[];  // e.g., ['type', 'category', 'author', 'tags']

  // Optional: Content type boosting
  typeBoosts?: Record<string, number>;  // e.g., { 'project': 1.2, 'news': 0.8 }

  // Optional: Recency boost for time-sensitive content
  recencyBoost?: {
    enabled: boolean;
    field: string;          // Metadata field containing date (e.g., 'publishedAt')
    decayDays: number;      // Content older than this gets reduced boost
    maxBoost?: number;      // Max boost for fresh content (default: 1.2)
  };

  // Chunking (large documents are split before embedding)
  maxChunkSize?: number;   // Default: 1500 characters (0 = no chunking)
  chunkOverlap?: number;   // Default: 200 characters

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

  /**
   * Persistent crawl ledger (MongoDB) — skip re-crawl within TTL, audit per URL.
   * Per-request overrides: pass `crawlLedger` on SitemapConfig / WebsiteCrawlConfig / etc.
   */
  crawlLedger?: CrawlLedgerPluginConfig;
}

/**
 * Global defaults for crawl ledger (MongoDB collection separate from vector content).
 */
export interface CrawlLedgerPluginConfig {
  /** Default off so existing installs behave the same */
  enabled?: boolean;
  /** Collection name (default: web_crawl_ledger) */
  collection?: string;
  /** Skip re-crawl if last status was indexed and younger than this (default: 7 days) */
  ttlMsIndexed?: number;
  /** Skip re-crawl if last status was a failure and younger than this (default: 1 hour) */
  ttlMsFailure?: number;
  /**
   * Skip re-crawl if last status was `error` (e.g. Playwright timeout) and younger than this.
   * Shorter than ttlMsFailure so transient render errors retry sooner (default: 5 minutes).
   */
  ttlMsRenderError?: number;
}

/**
 * Per-ingest crawl ledger options (merged over plugin.crawlLedger).
 * To bypass skip-TTL for one run: pass `forceRecrawl: true` on IngestOptions (SDK).
 */
export interface CrawlLedgerOptions {
  enabled?: boolean;
  ttlMsIndexed?: number;
  ttlMsFailure?: number;
  ttlMsRenderError?: number;
  /** Max rows in result.metadata.pageStatuses (default: 500) */
  maxPageStatuses?: number;
}

export type CrawlLedgerStatus =
  | 'indexed'
  | 'skipped_ledger'
  | 'too_small'
  | 'non_html'
  | 'blocked_suspected'
  | 'error';

export interface CrawlPageStatusEntry {
  url: string;
  urlNormalized?: string;
  status: CrawlLedgerStatus;
  modeUsed?: string;
  contentLength?: number;
  /** Raw-ish body text length before selector pick (debug) */
  bodyTextLengthHint?: number;
  title?: string;
  docId?: string;
  httpStatus?: number;
  error?: string;
  skippedReason?: string;
}

export interface CrawlLedgerDocument {
  tenantId: string;
  agentId: string;
  /** Correlates ledger rows with a single ingest run (from crawl metadata.ingestionId). */
  ingestionId?: string;
  urlNormalized: string;
  url: string;
  domain: string;
  lastStatus: CrawlLedgerStatus;
  lastCrawledAt: Date;
  modeUsed?: string;
  contentLength?: number;
  title?: string;
  docId?: string;
  httpStatus?: number;
  errorMessage?: string;
  updatedAt: Date;
}

/**
 * URL source for ingesting content from external APIs
 */
export interface URLSource {
  url: string;
  type: 'json' | 'csv' | 'xml' | 'api';
  auth?: URLSourceAuth;
  transform?: DataTransform;
  headers?: Record<string, string>;
  timeout?: number;  // Default: 30000
  metadata?: Record<string, any>;  // Additional metadata to add to all documents
}

export interface URLSourceAuth {
  type: 'bearer' | 'basic' | 'api-key' | 'custom';
  token?: string;          // For bearer
  username?: string;       // For basic
  password?: string;       // For basic
  header?: string;         // For api-key (header name)
  key?: string;            // For api-key (value)
  headers?: Record<string, string>;  // For custom
}

export interface DataTransform {
  // JSONPath to array of documents (e.g., 'data' for JSON:API)
  documentPath?: string;

  // Field mapping: target field → source path
  fieldMapping?: {
    id?: string;       // Path to ID field
    content?: string;  // Path to content field
    type?: string | (() => string);  // Path or static value
    [key: string]: string | (() => string) | undefined;
  };
}

/**
 * Drupal JSON:API specific configuration
 */
export interface DrupalConfig {
  baseUrl: string;
  contentTypes: string[];  // e.g., ['project', 'perspective', 'team_member']
  auth?: URLSourceAuth;
  
  // Field mappings per content type
  mappings?: Record<string, {
    content: string;  // Field path for main content
    fields?: Record<string, string>;  // Additional field mappings
  }>;
}

/**
 * WordPress REST API specific configuration
 */
export interface WordPressConfig {
  baseUrl: string;
  postTypes?: string[];  // e.g., ['posts', 'pages', 'custom_post_type'] - default: ['posts', 'pages']
  auth?: URLSourceAuth;
  
  // Pagination
  perPage?: number;  // Default: 100
  maxPages?: number;  // Default: 10 (max 1000 items)
  
  // Field mappings per post type
  mappings?: Record<string, {
    content?: string;  // Field path for main content (default: 'content.rendered')
    fields?: Record<string, string>;  // Additional field mappings
  }>;
}

/**
 * Sanity.io specific configuration
 */
export interface SanityConfig {
  projectId: string;
  dataset: string;  // e.g., 'production'
  apiVersion?: string;  // Default: 'v2024-01-01'
  token?: string;  // For private datasets
  useCdn?: boolean;  // Default: true
  
  // GROQ queries per content type
  queries: Record<string, {
    // GROQ query (e.g., '*[_type == "post"]')
    query: string;
    // Field path for main content
    content: string;
    // Additional field mappings
    fields?: Record<string, string>;
  }>;
}

/**
 * Strapi specific configuration
 */
export interface StrapiConfig {
  baseUrl: string;
  apiToken?: string;  // API token for authentication
  
  // Content types to ingest (collection names)
  contentTypes: string[];  // e.g., ['articles', 'pages', 'projects']
  
  // Pagination
  pageSize?: number;  // Default: 100
  maxPages?: number;  // Default: 10
  
  // Field mappings per content type
  mappings?: Record<string, {
    content?: string;  // Field path for main content (default: 'attributes.content')
    fields?: Record<string, string>;  // Additional field mappings
    // Strapi v4 uses 'attributes', set to false for v3
    useAttributes?: boolean;  // Default: true (Strapi v4)
  }>;
}

/**
 * Sitemap crawling configuration
 * For non-technical clients - just provide the sitemap URL
 */
export interface SitemapConfig {
  // Sitemap URL (e.g., 'https://example.com/sitemap.xml')
  // Or base URL - will auto-discover sitemap.xml
  sitemapUrl?: string;
  baseUrl?: string;

  // Crawling limits
  maxPages?: number;        // Default: 100
  concurrency?: number;     // Default: 3 (parallel requests)
  delayMs?: number;         // Default: 500 (delay between requests)
  timeout?: number;         // Default: 30000 (per page)

  // Content extraction
  contentSelector?: string;  // CSS selector for main content (e.g., 'article', '.content')
  titleSelector?: string;    // CSS selector for title (default: 'h1, title')
  removeSelectors?: string[];  // Elements to remove (e.g., ['nav', 'footer', '.sidebar'])
  /** Minimum cleaned text length to accept a page (default: 50) */
  minExtractedContentLength?: number;

  // URL filtering
  includePatterns?: string[];  // Only crawl URLs matching these patterns
  excludePatterns?: string[];  // Skip URLs matching these patterns (e.g., ['/cart', '/admin'])

  /** Strip query string for crawl ledger key (default: false) */
  stripQueryParams?: boolean;

  // Type inference from URL
  typeFromUrl?: Record<string, string>;  // e.g., { '/blog/': 'blog', '/projects/': 'project' }
  defaultType?: string;  // Default: 'page'

  // Additional metadata to add to all documents
  metadata?: Record<string, any>;

  /**
   * Rendering mode for JS-heavy sites
   * - false: only static HTML fetch
   * - true: always render with a headless browser
   * - "auto": try static first, render as fallback when content is too small / looks dynamic
   */
  render?: boolean | 'auto';

  /**
   * Render options (used when render is true/auto)
   */
  renderOptions?: RenderOptions;

  /**
   * Debug/observability options
   */
  debug?: DebugOptions;

  crawlLedger?: CrawlLedgerOptions;
}

/**
 * Direct URL list crawling configuration
 */
export interface UrlListConfig {
  // Content extraction
  contentSelector?: string;  // CSS selector for main content
  titleSelector?: string;    // CSS selector for title
  removeSelectors?: string[];  // Elements to remove

  // Crawling settings
  concurrency?: number;  // Default: 3
  delayMs?: number;      // Default: 500
  timeout?: number;      // Default: 30000

  // Type inference or static type
  type?: string;  // Static type for all URLs
  typeFromUrl?: Record<string, string>;  // Pattern-based type

  // Additional metadata
  metadata?: Record<string, any>;

  render?: boolean | 'auto';
  renderOptions?: RenderOptions;
  debug?: DebugOptions;

  stripQueryParams?: boolean;
  crawlLedger?: CrawlLedgerOptions;
}

/**
 * Single page ingestion (no discovery)
 */
export interface SinglePageConfig {
  url: string;

  // Content extraction
  contentSelector?: string;
  titleSelector?: string;
  removeSelectors?: string[];

  // Crawling settings
  timeout?: number; // Default: 30000

  // Type inference or static type
  type?: string; // Static type for this URL (default: 'page')
  typeFromUrl?: Record<string, string>;

  // Additional metadata
  metadata?: Record<string, any>;

  render?: boolean | 'auto';
  renderOptions?: RenderOptions;
  debug?: DebugOptions;

  /** Ledger key normalization (default: true) */
  stripQueryParams?: boolean;
  crawlLedger?: CrawlLedgerOptions;
}

/**
 * Website crawling configuration (no sitemap)
 * Discovers internal links starting from a base URL and then crawls them.
 */
export interface WebsiteCrawlConfig {
  // Entry point (e.g., 'https://example.com')
  baseUrl: string;

  // Discovery limits
  maxPages?: number;        // Default: 100 (total pages to crawl)
  maxDepth?: number;        // Default: 3 (link depth from baseUrl)

  // Crawling settings (same meaning as sitemap crawling)
  concurrency?: number;     // Default: 3
  delayMs?: number;         // Default: 500 (delay between discovery batches and crawl batches)
  timeout?: number;         // Default: 30000

  // URL filtering
  includePatterns?: string[];  // Only include URLs matching these patterns
  excludePatterns?: string[];  // Skip URLs matching these patterns

  // URL normalization
  stripQueryParams?: boolean;  // Default: true (treat ?x=y as same page)

  // Content extraction (same as sitemap crawling)
  contentSelector?: string;
  titleSelector?: string;
  removeSelectors?: string[];

  // Type inference from URL
  typeFromUrl?: Record<string, string>;
  defaultType?: string;  // Default: 'page'

  // Additional metadata to add to all documents
  metadata?: Record<string, any>;

  render?: boolean | 'auto';
  renderOptions?: RenderOptions;
  debug?: DebugOptions;

  crawlLedger?: CrawlLedgerOptions;
}

export interface RenderOptions {
  /**
   * Minimum extracted content length to accept from static crawl before falling back to render.
   * Used only when render === "auto".
   */
  minContentLength?: number; // Default: 200

  /**
   * Navigation wait strategy for the headless browser.
   */
  waitUntil?: 'domcontentloaded' | 'load' | 'networkidle';

  /**
   * Optional selector that indicates the page's main content is ready.
   */
  waitForSelector?: string;

  /**
   * Scroll settings for infinite scroll pages.
   */
  scroll?: {
    enabled?: boolean;
    maxScrolls?: number;       // Default: 10
    scrollDelayMs?: number;    // Default: 750
    stableIterations?: number; // Default: 2 (stop when text doesn't grow)
  };

  /**
   * Wait after navigation (and optional waitForSelector) before reading HTML.
   * Helps WordPress/Elementor and other late-hydrated layouts.
   */
  postRenderDelayMs?: number;
}

export interface DebugOptions {
  enabled?: boolean;
  level?: 'summary' | 'verbose'; // Default: 'summary'
  saveDir?: string; // If provided, save per-URL artifacts (html/txt/json)
  maxPerUrlLogs?: number; // Default: 200 (cap verbose entries)
}

/**
 * RSS/Atom feed configuration
 */
export interface RSSConfig {
  feedUrl: string;

  // Content options
  useFullContent?: boolean;  // Use full content if available (default: true)
  fetchFullContent?: boolean;  // Fetch full page content for each item (default: false)
  contentSelector?: string;  // If fetchFullContent, use this selector

  // Type for all items
  type?: string;  // Default: 'post'

  // Additional metadata
  metadata?: Record<string, any>;
}

/**
 * Crawl result for sitemap/URL crawling
 */
export type CrawlProgressPhase = 'discovering' | 'crawling' | 'indexing';

/** Live crawl progress (via `metadata.onCrawlProgress` on WebsiteCrawlConfig). */
export interface CrawlProgressUpdate {
  phase: CrawlProgressPhase;
  /** URLs found in sitemap/BFS (may exceed urlsScheduled when capped by maxPages). */
  urlsDiscovered?: number;
  /** URLs that will be crawled in this run (≤ maxPages). */
  urlsScheduled?: number;
  /** During crawl: batches done. During indexing: documents fully embedded so far. */
  pagesProcessed?: number;
  /** During indexing: total text chunks to embed (drives web_content writes). */
  chunksTotal?: number;
  /** During indexing: chunks embedded so far. */
  chunksProcessed?: number;
}

export type CrawlProgressCallback = (update: CrawlProgressUpdate) => void;

export type BulkProgressPhase = 'processing' | 'indexing';

/** Live bulk progress (via `metadata.onBulkProgress` on IngestOptions). */
export interface BulkProgressUpdate {
  phase: BulkProgressPhase;
  opsTotal: number;
  opsDone: number;
  currentOpType?: 'insert' | 'update' | 'delete';
  currentUrl?: string;
}

export type BulkProgressCallback = (update: BulkProgressUpdate) => void;

/** Per-URL crawl lifecycle (via `metadata.onCrawlPage` on WebsiteCrawlConfig). */
export type CrawlPageEvent = {
  url: string;
  event: 'start' | 'done';
  status?: string;
  error?: string;
};

export type CrawlPageCallback = (event: CrawlPageEvent) => void;

export interface CrawlResult extends WebIngestResult {
  urlsCrawled: number;
  urlsSkipped: number;
  urlsFailed: number;
  /** URLs selected for this crawl batch (≤ maxPages); for progress UI. */
  urlsScheduled?: number;
  crawledAt: Date;
}

/**
 * Ingest result
 */
export interface WebIngestResult {
  success: boolean;
  indexed: number;
  failed: number;
  errors?: Array<{ id: string; error: string }>;
  metadata?: Record<string, any>;
}

/**
 * URL ingest result
 */
export interface WebURLIngestResult extends WebIngestResult {
  sourceUrl: string;
  fetchedAt: Date;
  documentsFetched: number;
}

