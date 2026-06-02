import { AgentClient } from './core/Client';
import type { ClientConfig } from './types';

// Main Client
export { AgentClient } from './core/Client';

// Core Classes
export { Agent } from './core/Agent';
export type { AgentGenerateOptions, BuildSystemPromptFn } from './core/Agent';
export { Thread } from './core/Thread';
export { PluginManager } from './core/PluginManager';

// Plugin Registry (for plugin persistence)
export {
  PluginRegistry,
  pluginRegistry, // Default global instance
  resolveEnvVars,
  envRef,
} from './core/PluginRegistry';
export type { PluginFactory } from './core/PluginRegistry';

// Tool utilities
export { convertTool, convertToolPlugins } from './core/toolUtils';

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
  IngestPlanDocument,
  IngestPlanInfo,
  IngestDocumentProgress,
  IngestProgressPhase,
  IngestProgressEvent,
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
  PluginRegistryInterface,
} from './types';

// Errors
export {
  AgentSDKError,
  AgentNotFoundError,
  ThreadNotFoundError,
  ProviderNotFoundError,
  InvalidConfigError,
} from './types';

// Edge-safe storage — no external dependencies
// For MongoDB: import { MongoDBStorage } from '@snap-agent/core/storage/mongodb'
// For Upstash:  import { UpstashStorage } from '@snap-agent/core/storage/upstash'
export { MemoryStorage } from './storage/MemoryStorage';

// Convenience function to create a client
export function createClient(config: ClientConfig): AgentClient {
  return new AgentClient(config);
}

