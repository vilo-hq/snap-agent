export { SnapAgentAnalytics } from './SnapAgentAnalytics';
export type {
  AnalyticsConfig,
  // Event types
  MetricEvent,
  FlushData,
  // Metric types
  PerformanceMetrics,
  RAGAnalyticsMetrics,
  CostMetrics,
  ConversationMetrics,
  ErrorMetrics,
  // Aggregated types
  AggregatedMetrics,
  TimeSeriesMetric,
  PercentileMetrics,
} from './SnapAgentAnalytics';

// Storage adapters
export { MemoryAnalyticsStorage, MongoAnalyticsStorage } from './storage';
export type {
  AnalyticsStorage,
  StoredRequest,
  StoredResponse,
  StoredError,
  AnalyticsQueryOptions,
  AggregationOptions,
  MongoAnalyticsStorageConfig,
} from './storage';

// Re-export types from core for convenience
export type {
  PerformanceTimings,
  RAGMetrics,
  TokenMetrics,
  RequestTrackingData,
  ResponseTrackingData,
  ErrorTrackingData,
} from '@snap-agent/core';

