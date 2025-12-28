import type { PerformanceTimings, RAGMetrics, TokenMetrics } from '@snap-agent/core';

// ============================================================================
// Stored Data Types (exported for storage implementations)
// ============================================================================

export interface StoredRequest {
  id: string;
  agentId: string;
  threadId?: string;
  userId?: string;
  timestamp: Date;
  messageLength: number;
  model?: string;
  provider?: string;
}

export interface StoredResponse {
  id: string;
  requestId: string;
  agentId: string;
  threadId?: string;
  userId?: string;
  timestamp: Date;
  responseLength: number;
  timings: PerformanceTimings;
  tokens: TokenMetrics;
  rag?: RAGMetrics;
  success: boolean;
  errorType?: string;
  model?: string;
  provider?: string;
}

export interface StoredError {
  id: string;
  agentId: string;
  threadId?: string;
  timestamp: Date;
  errorType: string;
  errorMessage: string;
  component?: string;
}

// ============================================================================
// Query Options
// ============================================================================

export interface AnalyticsQueryOptions {
  agentId?: string;
  threadId?: string;
  userId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

export interface AggregationOptions extends AnalyticsQueryOptions {
  groupBy?: 'hour' | 'day' | 'week' | 'month';
}

// ============================================================================
// Analytics Storage Interface
// ============================================================================

/**
 * Storage adapter interface for analytics data persistence.
 * Implementations handle storage and retrieval of analytics metrics.
 */
export interface AnalyticsStorage {
  /**
   * Save request records
   */
  saveRequests(requests: StoredRequest[]): Promise<void>;

  /**
   * Save response records
   */
  saveResponses(responses: StoredResponse[]): Promise<void>;

  /**
   * Save error records
   */
  saveErrors(errors: StoredError[]): Promise<void>;

  /**
   * Get requests with optional filtering
   */
  getRequests(options?: AnalyticsQueryOptions): Promise<StoredRequest[]>;

  /**
   * Get responses with optional filtering
   */
  getResponses(options?: AnalyticsQueryOptions): Promise<StoredResponse[]>;

  /**
   * Get errors with optional filtering
   */
  getErrors(options?: AnalyticsQueryOptions): Promise<StoredError[]>;

  /**
   * Get aggregated request count by time period
   */
  getRequestCount(options?: AggregationOptions): Promise<number>;

  /**
   * Get aggregated response count by time period
   */
  getResponseCount(options?: AggregationOptions): Promise<number>;

  /**
   * Get aggregated error count by time period
   */
  getErrorCount(options?: AggregationOptions): Promise<number>;

  /**
   * Delete records older than the specified date
   */
  deleteOlderThan(date: Date): Promise<{ requests: number; responses: number; errors: number }>;

  /**
   * Clear all analytics data
   */
  clear(): Promise<void>;

  /**
   * Check if storage is connected and ready
   */
  isReady(): Promise<boolean>;

  /**
   * Close the storage connection (if applicable)
   */
  close(): Promise<void>;
}

