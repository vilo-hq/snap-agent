import type { Plugin, StoredPluginConfig } from './plugins';

// ============================================================================
// Provider Types
// ============================================================================

export type ProviderType = 'openai' | 'anthropic' | 'google' | 'huggingface';

export interface ProviderConfig {
  openai?: {
    apiKey: string;
  };
  anthropic?: {
    apiKey: string;
  };
  google?: {
    apiKey: string;
  };
  huggingface?: { 
    apiKey: string 
  }
}

// ============================================================================
// Agent Types
// ============================================================================

/**
 * RAG configuration for zero-config RAG setup
 */
export interface RAGConfig {
  /**
   * Enable RAG with default plugin
   */
  enabled: boolean;

  /**
   * API key for embedding provider
   * If not provided, will use the provider's API key from ClientConfig
   */
  embeddingProviderApiKey?: string;

  /**
   * Embedding provider to use
   * @default 'openai'
   */
  embeddingProvider?: 'openai';

  /**
   * Embedding model to use
   * @default 'text-embedding-3-small'
   */
  embeddingModel?: string;

  /**
   * Number of results to return
   * @default 5
   */
  limit?: number;
}

export interface AgentConfig {
  name: string;
  description?: string;
  instructions: string;
  provider: ProviderType;
  model: string;
  userId: string;
  metadata?: Record<string, any>;
  organizationId?: string;
  phone?: string;
  plugins?: Plugin[]; // Runtime plugin instances (not persisted)
  pluginConfigs?: StoredPluginConfig[]; // Serializable plugin configs (persisted to storage)
  rag?: RAGConfig; // Zero-config RAG support
}

export interface AgentData extends AgentConfig {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  files: AgentFile[];
}

export interface AgentFile {
  fileId: string;
  filename: string;
  addedAt: Date;
}

// ============================================================================
// Thread Types
// ============================================================================

export interface ThreadConfig {
  agentId: string;
  userId: string;
  name?: string;
  metadata?: Record<string, any>;
  organizationId?: string;
  endUserId?: string;
}

export interface ThreadData extends ThreadConfig {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  messages: MessageData[];
  isPendingThread: boolean;
}

// ============================================================================
// Message Types
// ============================================================================

export type MessageRole = 'user' | 'assistant' | 'system';

export interface MessageData {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  metadata?: Record<string, any>;
  attachments?: MessageAttachment[];
}

export interface MessageAttachment {
  fileId: string;
  filename: string;
  contentType: string;
  size: number;
}

// ============================================================================
// Chat Types
// ============================================================================

export interface ChatRequest {
  threadId: string;
  message: string;
  attachments?: MessageAttachment[];
  useRAG?: boolean; // Enable RAG plugins
  ragFilters?: Record<string, any>; // Filters for RAG plugins
  contextLength?: number; // Number of messages to include in context (default: 20)
}

export interface ChatResponse {
  reply: string;
  messageId: string;
  threadId: string;
  timestamp: Date;
  metadata?: Record<string, any>; // Plugin metadata
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ============================================================================
// Run Types (Headless / Backend mode)
// ============================================================================

/**
 * Webhook delivery configuration for headless agent runs
 */
export interface WebhookConfig {
  /** URL to POST results to */
  url: string;
  /** Additional headers to include in the webhook request */
  headers?: Record<string, string>;
  /** Secret for HMAC-SHA256 signature (sent as X-Signature-256 header) */
  secret?: string;
}

/**
 * Request to run an agent in headless mode (no thread, no message history)
 * Designed for backend/automation use cases: webhooks, cron jobs, pipelines
 */
export interface RunRequest {
  /** Agent ID to execute */
  agentId: string;
  /** Text instruction for the agent */
  input: string;
  /** Optional structured payload — serialized and appended to the input as context */
  payload?: Record<string, any>;
  /** Enable RAG plugins */
  useRAG?: boolean;
  /** Filters for RAG plugins */
  ragFilters?: Record<string, any>;
  /** Maximum number of tool-call round-trips (default: 5) */
  maxToolSteps?: number;
  /** Optional: deliver the result to a webhook URL */
  webhook?: WebhookConfig;
}

/**
 * Result of a headless agent run
 */
export interface RunResponse {
  /** Agent's text output */
  output: string;
  /** Parsed output (when agent uses JSON/object output mode) */
  parsed?: unknown;
  /** Plugin metadata (RAG sources, latency, etc.) */
  metadata?: Record<string, any>;
  /** Webhook delivery result (only present when webhook was configured) */
  webhookDelivery?: {
    success: boolean;
    statusCode?: number;
    error?: string;
  };
}

export interface StreamCallbacks {
  onChunk: (chunk: string) => void;
  onComplete: (fullResponse: string, metadata?: Record<string, any>) => void;
  onError: (error: Error) => void;
}

// ============================================================================
// Storage Types
// ============================================================================

export interface StorageAdapter {
  // Agent operations
  createAgent(config: AgentConfig): Promise<string>;
  getAgent(agentId: string): Promise<AgentData | null>;
  updateAgent(agentId: string, updates: Partial<AgentConfig>): Promise<void>;
  deleteAgent(agentId: string): Promise<void>;
  listAgents(userId: string, organizationId?: string): Promise<AgentData[]>;

  // Thread operations
  createThread(config: ThreadConfig): Promise<string>;
  getThread(threadId: string): Promise<ThreadData | null>;
  updateThread(threadId: string, updates: Partial<ThreadConfig>): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  listThreads(filters: {
    userId?: string;
    agentId?: string;
    organizationId?: string;
  }): Promise<ThreadData[]>;

  // Message operations
  addMessage(
    threadId: string,
    role: MessageRole,
    content: string,
    attachments?: MessageAttachment[]
  ): Promise<string>;
  getMessages(threadId: string, limit?: number): Promise<MessageData[]>;
  getConversationContext(threadId: string, maxMessages?: number): Promise<Array<{ role: string; content: string }>>;
}

// ============================================================================
// Client Config
// ============================================================================

/**
 * Plugin registry for reinstantiating plugins from stored configs
 * Import from '@snap-agent/core' or create your own instance
 */
export interface PluginRegistryInterface {
  instantiateAll(storedConfigs: StoredPluginConfig[]): Promise<Plugin[]>;
  isRegistered(name: string): boolean;
}

export interface ClientConfig {
  storage: StorageAdapter;
  providers: ProviderConfig;
  /**
   * Optional plugin registry for automatic plugin reinstantiation
   * When provided, agents loaded with getAgent() will automatically
   * reinstantiate their plugins from stored configurations
   */
  pluginRegistry?: PluginRegistryInterface;
}

// ============================================================================
// Error Types
// ============================================================================

export class AgentSDKError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSDKError';
  }
}

export class AgentNotFoundError extends AgentSDKError {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = 'AgentNotFoundError';
  }
}

export class ThreadNotFoundError extends AgentSDKError {
  constructor(threadId: string) {
    super(`Thread not found: ${threadId}`);
    this.name = 'ThreadNotFoundError';
  }
}

export class CouldNotCreateThreadError extends AgentSDKError {
  constructor(threadId: string) {
    super(`Could not create thread: ${threadId}`);
    this.name = 'CouldNotCreateThreadError';
  }
}

export class ProviderNotFoundError extends AgentSDKError {
  constructor(provider: string) {
    super(`Provider not configured: ${provider}`);
    this.name = 'ProviderNotFoundError';
  }
}

export class InvalidConfigError extends AgentSDKError {
  constructor(message: string) {
    super(`Invalid configuration: ${message}`);
    this.name = 'InvalidConfigError';
  }
}

// ============================================================================
// Re-export Plugin Types
// ============================================================================

export type {
  Plugin,
  BasePlugin,
  RAGPlugin,
  RAGContext,
  RAGDocument,
  IngestResult,
  IngestOptions,
  BulkOperation,
  BulkResult,
  URLSource,
  URLSourceAuth,
  DataTransform,
  IngestionSchedule,
  URLIngestResult,
  ToolPlugin,
  Tool,
  MiddlewarePlugin,
  AnalyticsPlugin,
  // Analytics types
  PerformanceTimings,
  RAGMetrics,
  TokenMetrics,
  RequestTrackingData,
  ResponseTrackingData,
  ErrorTrackingData,
  // Plugin persistence
  StoredPluginConfig,
} from './plugins';

