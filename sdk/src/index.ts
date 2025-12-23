import { AgentClient } from './core/Client';
import { ClientConfig } from './types';

// Main Client
export { AgentClient } from './core/Client';

// Core Classes
export { Agent } from './core/Agent';
export { Thread } from './core/Thread';
export { PluginManager } from './core/PluginManager';

// Providers
export { ProviderFactory, Models } from './providers';

// Built-in (included with SDK)
export { DefaultRAGPlugin } from './inc';
export type { DefaultRAGConfig } from './inc';

// Types
export type {
  ProviderType,
  ProviderConfig,
  AgentConfig,
  AgentData,
  AgentFile,
  ThreadConfig,
  ThreadData,
  MessageData,
  MessageRole,
  MessageAttachment,
  ChatRequest,
  ChatResponse,
  StreamCallbacks,
  StorageAdapter,
  ClientConfig,
  RAGConfig,
  // Plugin types
  Plugin,
  BasePlugin,
  RAGPlugin,
  RAGContext,
  RAGDocument,
  IngestResult,
  IngestOptions,
  BulkOperation,
  BulkResult,
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
} from './types';

// Errors
export {
  AgentSDKError,
  AgentNotFoundError,
  ThreadNotFoundError,
  ProviderNotFoundError,
  InvalidConfigError,
} from './types';

// Storage (re-export for convenience, but also available via '@snap-agent/core/storage')
export { MongoDBStorage, MemoryStorage, UpstashStorage } from './storage';
export type { MongoDBStorageConfig, UpstashStorageConfig } from './storage';

// Convenience function to create a client
export function createClient(config: ClientConfig): AgentClient {
  return new AgentClient(config);
}

