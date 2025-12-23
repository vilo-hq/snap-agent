/**
 * Plugin system for extending agent capabilities
 */

// ============================================================================
// Base Plugin Interface
// ============================================================================

export interface BasePlugin {
  name: string;
  type: 'rag' | 'tool' | 'middleware' | 'analytics';
  priority?: number; // Lower = executed first (default: 100)
}

// ============================================================================
// RAG Plugin
// ============================================================================

export interface RAGContext {
  content: string;
  sources?: Array<{
    id: string;
    title?: string;
    score?: number;
    type?: string;
    [key: string]: any;
  }>;
  metadata?: Record<string, any>;
}

/**
 * Document to be ingested into RAG system
 */
export interface RAGDocument {
  id: string;
  content: string;
  metadata?: Record<string, any>;
}

/**
 * Result of an ingestion operation
 */
export interface IngestResult {
  success: boolean;
  indexed: number;
  failed: number;
  errors?: Array<{
    id: string;
    error: string;
  }>;
  metadata?: Record<string, any>;
}

/**
 * Options for ingestion operations
 */
export interface IngestOptions {
  agentId?: string;
  batchSize?: number;
  skipExisting?: boolean;
  overwrite?: boolean;
  [key: string]: any;
}

/**
 * Options for bulk operations
 * For 'insert': document with full RAGDocument required
 * For 'update': document with Partial<RAGDocument> optional
 * For 'delete': document not needed
 */
export type BulkOperation =
  | {
    type: 'insert';
    id: string;
    document: RAGDocument;
  }
  | {
    type: 'update';
    id: string;
    document?: Partial<RAGDocument>;
  }
  | {
    type: 'delete';
    id: string;
    document?: never;
  };

export interface BulkResult {
  success: boolean;
  inserted: number;
  updated: number;
  deleted: number;
  failed: number;
  errors?: Array<{
    id: string;
    operation: string;
    error: string;
  }>;
}

/**
 * Authentication configuration for URL-based ingestion
 */
export type URLSourceAuth =
  | {
    type: 'bearer';
    token: string;
  }
  | {
    type: 'basic';
    username: string;
    password: string;
  }
  | {
    type: 'api-key';
    header: string;
    key: string;
  }
  | {
    type: 'custom';
    headers: Record<string, string>;
  };

/**
 * Configuration for transforming external data to RAGDocuments
 */
export interface DataTransform {
  // JSONPath expression to extract documents from response (for JSON/API)
  documentPath?: string;

  // Map external field names to RAGDocument fields
  fieldMapping?: {
    id?: string;
    content?: string;
    [key: string]: string | undefined;
  };

  // Custom transformation function (for complex mappings)
  customTransform?: (data: any) => RAGDocument[];
}

/**
 * Schedule configuration for recurring ingestion
 */
export interface IngestionSchedule {
  // Cron expression (e.g., '0 */4 * * *' = every 4 hours)
  cron?: string;

  // Interval in milliseconds
  interval?: number;

  // Timezone for cron (default: UTC)
  timezone?: string;
}

/**
 * URL source configuration for data ingestion
 */
export interface URLSource {
  // Source URL (CSV, JSON, XML, or API endpoint)
  url: string;

  // Data format type
  type: 'json' | 'csv' | 'xml' | 'api';

  // Optional authentication
  auth?: URLSourceAuth;

  // Data transformation rules
  transform?: DataTransform;

  // Optional scheduling for recurring syncs
  schedule?: IngestionSchedule;

  // Custom headers
  headers?: Record<string, string>;

  // Request timeout in milliseconds (default: 30000)
  timeout?: number;

  // Additional metadata to attach to ingested documents
  metadata?: Record<string, any>;
}

/**
 * Result of URL-based ingestion
 */
export interface URLIngestResult extends IngestResult {
  sourceUrl: string;
  fetchedAt: Date;
  documentsFetched: number;
  scheduleId?: string; // If scheduled sync was created
}

export interface RAGPlugin extends BasePlugin {
  type: 'rag';

  /**
   * Retrieve contextual information for a message
   */
  retrieveContext(
    message: string,
    options: {
      agentId: string;
      threadId?: string;
      filters?: Record<string, any>;
      metadata?: Record<string, any>;
    }
  ): Promise<RAGContext>;

  /**
   * Optional: Format the context for the LLM
   * If not provided, RAGContext.content will be used directly
   */
  formatContext?(context: RAGContext): string;

  /**
   * Optional: Ingest documents into the RAG system
   * Allows plugins to provide their own indexing logic
   */
  ingest?(
    documents: RAGDocument[],
    options?: IngestOptions
  ): Promise<IngestResult>;

  /**
   * Optional: Ingest documents from a URL source
   * Supports CSV, JSON, XML, and API endpoints with authentication and scheduling
   */
  ingestFromUrl?(
    source: URLSource,
    options?: IngestOptions
  ): Promise<URLIngestResult>;

  /**
   * Optional: Handle webhook payloads for real-time updates
   * Useful for product updates, inventory changes, etc.
   */
  handleWebhook?(
    payload: any,
    source: string,
    options?: IngestOptions
  ): Promise<IngestResult>;

  /**
   * Optional: Update a single document
   */
  update?(
    id: string,
    document: Partial<RAGDocument>,
    options?: IngestOptions
  ): Promise<void>;

  /**
   * Optional: Delete document(s) by ID
   */
  delete?(
    ids: string | string[],
    options?: IngestOptions
  ): Promise<number>;

  /**
   * Optional: Bulk operations for efficient batch processing
   */
  bulk?(
    operations: BulkOperation[],
    options?: IngestOptions
  ): Promise<BulkResult>;
}

// ============================================================================
// Tool Plugin
// ============================================================================

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: any) => Promise<any>;
}

export interface ToolPlugin extends BasePlugin {
  type: 'tool';
  getTools(): Tool[];
}

// ============================================================================
// Middleware Plugin
// ============================================================================

export interface MiddlewarePlugin extends BasePlugin {
  type: 'middleware';

  beforeRequest?(
    messages: any[],
    context: { agentId: string; threadId?: string }
  ): Promise<{ messages: any[]; metadata?: any }>;

  afterResponse?(
    response: string,
    context: { agentId: string; threadId?: string; metadata?: any }
  ): Promise<{ response: string; metadata?: any }>;
}

// ============================================================================
// Analytics Plugin
// ============================================================================

/**
 * Performance timing breakdown
 */
export interface PerformanceTimings {
  total: number;
  llmApiTime?: number;
  ragRetrievalTime?: number;
  pluginExecutionTime?: number;
  dbQueryTime?: number;
  timeToFirstToken?: number;
  timeToLastToken?: number;
  queueTime?: number;
}

/**
 * RAG-specific metrics
 */
export interface RAGMetrics {
  enabled: boolean;
  documentsRetrieved?: number;
  vectorSearchTime?: number;
  embeddingTime?: number;
  cacheHit?: boolean;
  avgSimilarityScore?: number;
  rerankTime?: number;
  contextLength?: number;
  contextTokens?: number;
  sourcesCount?: number;
}

/**
 * Token and cost metrics
 */
export interface TokenMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost?: number;
  embeddingTokens?: number;
  embeddingCost?: number;
}

/**
 * Request tracking data (extended)
 */
export interface RequestTrackingData {
  agentId: string;
  threadId?: string;
  userId?: string;
  organizationId?: string;
  message: string;
  messageLength: number;
  timestamp: Date;
  model?: string;
  provider?: string;
}

/**
 * Response tracking data (extended)
 */
export interface ResponseTrackingData {
  agentId: string;
  threadId?: string;
  userId?: string;
  organizationId?: string;
  response: string;
  responseLength: number;
  timestamp: Date;

  // Performance
  timings: PerformanceTimings;

  // Tokens & Cost
  tokens: TokenMetrics;

  // RAG (if enabled)
  rag?: RAGMetrics;

  // Status
  success: boolean;
  errorType?: string;
  errorMessage?: string;

  // Model info
  model?: string;
  provider?: string;
}

/**
 * Error tracking data
 */
export interface ErrorTrackingData {
  agentId: string;
  threadId?: string;
  timestamp: Date;
  errorType: string;
  errorMessage: string;
  errorCode?: string;
  isRetryable?: boolean;
  component?: 'llm' | 'rag' | 'plugin' | 'database' | 'network';
}

export interface AnalyticsPlugin extends BasePlugin {
  type: 'analytics';

  /**
   * Track incoming request (basic - for backwards compatibility)
   */
  trackRequest(data: {
    agentId: string;
    threadId?: string;
    message: string;
    timestamp: Date;
  }): Promise<void>;

  /**
   * Track response (basic - for backwards compatibility)
   */
  trackResponse(data: {
    agentId: string;
    threadId?: string;
    response: string;
    latency: number;
    tokensUsed?: number;
    timestamp: Date;
  }): Promise<void>;

  /**
   * Track request with extended data (optional)
   */
  trackRequestExtended?(data: RequestTrackingData): Promise<void>;

  /**
   * Track response with extended metrics (optional)
   */
  trackResponseExtended?(data: ResponseTrackingData): Promise<void>;

  /**
   * Track errors (optional)
   */
  trackError?(data: ErrorTrackingData): Promise<void>;

  /**
   * Get aggregated metrics (optional)
   */
  getMetrics?(options?: {
    agentId?: string;
    startDate?: Date;
    endDate?: Date;
    groupBy?: 'hour' | 'day' | 'week' | 'month';
  }): Promise<Record<string, any>>;
}

// ============================================================================
// Union Type
// ============================================================================

export type Plugin = RAGPlugin | ToolPlugin | MiddlewarePlugin | AnalyticsPlugin;


