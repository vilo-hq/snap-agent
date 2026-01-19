// ============================================================================
// CMS RAG Plugin Types
// Schema-agnostic content types for any CMS
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
export interface CMSDocument {
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
export interface StoredCMSDocument extends CMSDocument {
  tenantId: string;
  agentId?: string;
  embedding: number[];
  createdAt: Date;
  updatedAt?: Date;
}

/**
 * Plugin configuration
 */
export interface CMSRAGConfig {
  // MongoDB connection
  mongoUri: string;
  dbName: string;
  collection?: string;  // Default: 'cms_content'

  // AI configuration
  openaiApiKey: string;
  embeddingModel?: string;  // Default: 'text-embedding-3-small'

  // Tenant isolation
  tenantId: string;

  // Search configuration
  vectorIndexName?: string;  // Default: 'cms_vector_index'
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

  // URL filtering
  includePatterns?: string[];  // Only crawl URLs matching these patterns
  excludePatterns?: string[];  // Skip URLs matching these patterns (e.g., ['/cart', '/admin'])

  // Type inference from URL
  typeFromUrl?: Record<string, string>;  // e.g., { '/blog/': 'blog', '/projects/': 'project' }
  defaultType?: string;  // Default: 'page'

  // Additional metadata to add to all documents
  metadata?: Record<string, any>;
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
export interface CrawlResult extends CMSIngestResult {
  urlsCrawled: number;
  urlsSkipped: number;
  urlsFailed: number;
  crawledAt: Date;
}

/**
 * Ingest result
 */
export interface CMSIngestResult {
  success: boolean;
  indexed: number;
  failed: number;
  errors?: Array<{ id: string; error: string }>;
  metadata?: Record<string, any>;
}

/**
 * URL ingest result
 */
export interface CMSURLIngestResult extends CMSIngestResult {
  sourceUrl: string;
  fetchedAt: Date;
  documentsFetched: number;
}

