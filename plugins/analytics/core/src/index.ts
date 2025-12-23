export { SnapAgentAnalytics } from './SnapAgentAnalytics';
export type {
  AnalyticsConfig,
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

// Re-export types from core for convenience
export type {
  PerformanceTimings,
  RAGMetrics,
  TokenMetrics,
  RequestTrackingData,
  ResponseTrackingData,
  ErrorTrackingData,
} from '@snap-agent/core';

