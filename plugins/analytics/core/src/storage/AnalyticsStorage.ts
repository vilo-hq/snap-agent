import type { PerformanceTimings, RAGMetrics, TokenMetrics } from '@snap-agent/core';

// ============================================================================
// Stored Data Types (exported for storage implementations)
// ============================================================================

export interface StoredRequest {
  id: string;
  agentId: string;
  threadId?: string;
  userId?: string;
  /** Links the request/response/error records of a single agent turn. */
  correlationId?: string;
  timestamp: Date;
  messageLength: number;
  model?: string;
  provider?: string;
}

export interface StoredResponse {
  id: string;
  agentId: string;
  threadId?: string;
  userId?: string;
  /** Links the request/response/error records of a single agent turn. */
  correlationId?: string;
  timestamp: Date;
  responseLength: number;
  timings: PerformanceTimings;
  tokens: TokenMetrics;
  rag?: RAGMetrics;
  success: boolean;
  errorType?: string;
  /** Explicit outcome; when omitted it's derived from `success`. 'blocked' = short-circuited (e.g. moderation). */
  status?: 'success' | 'error' | 'blocked';
  level?: 'info' | 'warning' | 'error';
  warningReasons?: string[];
  component?: string;
  model?: string;
  provider?: string;
}

export interface StoredError {
  id: string;
  agentId: string;
  threadId?: string;
  userId?: string;
  /** Links the request/response/error records of a single agent turn. */
  correlationId?: string;
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
// System Logs (unified request/response/error feed)
// ============================================================================

export type SystemLogLevel = 'info' | 'warning' | 'error';

export interface SystemLogCursor {
  timestamp: string;
  id: string;
}

export interface SystemLogFilter {
  agentId?: string;
  from?: Date;
  to?: Date;
  level?: SystemLogLevel;
  component?: string;
  limit?: number;
  cursor?: SystemLogCursor;
}

export interface SystemLogEntry {
  id: string;
  timestamp: Date;
  level: SystemLogLevel;
  component?: string;
  agentId: string;
  threadId?: string;
  /** Links the request/response/error records of a single agent turn. */
  correlationId?: string;
  model?: string;
  provider?: string;
  latency?: number;
  status: 'success' | 'error' | 'blocked';
  errorType?: string;
  errorMessage?: string;
  warningReasons?: string[];
  tokens?: TokenMetrics;
  rag?: RAGMetrics;
  responseLength?: number;
}

export interface SystemLogPage {
  logs: SystemLogEntry[];
  nextCursor?: SystemLogCursor;
}

/** Map a stored response into a unified system-log entry. */
export function responseToSystemLog(r: StoredResponse): SystemLogEntry {
  const level: SystemLogLevel = r.level ?? (r.success ? 'info' : 'error');
  return {
    id: r.id,
    timestamp: r.timestamp,
    level,
    component: r.component ?? 'llm',
    agentId: r.agentId,
    threadId: r.threadId,
    correlationId: r.correlationId,
    model: r.model,
    provider: r.provider,
    latency: r.timings?.total,
    status: r.status ?? (r.success ? 'success' : 'error'),
    errorType: r.errorType,
    warningReasons: r.warningReasons,
    tokens: r.tokens,
    rag: r.rag,
    responseLength: r.responseLength,
  };
}

/** Map a stored error into a unified system-log entry. */
export function errorToSystemLog(e: StoredError): SystemLogEntry {
  return {
    id: e.id,
    timestamp: e.timestamp,
    level: 'error',
    component: e.component,
    agentId: e.agentId,
    threadId: e.threadId,
    correlationId: e.correlationId,
    status: 'error',
    errorType: e.errorType,
    errorMessage: e.errorMessage,
  };
}

/**
 * True when (timestamp, id) sorts strictly after the cursor in reverse-chron
 * order — i.e. the entry belongs on a later page. Used to resume pagination
 * without dropping records that share the cursor's timestamp. Ids are compared
 * as strings (they are `res-<uuid>`/`err-<uuid>`/`req-<uuid>`), so the tiebreak
 * is deterministic and stable across process restarts.
 */
export function isBeforeCursor(timestamp: Date, id: string, cursor: SystemLogCursor): boolean {
  const cursorTime = new Date(cursor.timestamp).getTime();
  const t = timestamp.getTime();
  if (t < cursorTime) return true;
  if (t > cursorTime) return false;
  return id < cursor.id;
}

/** Merge, sort (newest first, id tiebreak) and paginate system-log entries. */
export function mergeSystemLogs(entries: SystemLogEntry[], limit: number): SystemLogPage {
  const sorted = entries.slice().sort((a, b) => {
    const diff = b.timestamp.getTime() - a.timestamp.getTime();
    if (diff !== 0) return diff;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  const hasMore = sorted.length > limit;
  const logs = sorted.slice(0, limit);
  const last = logs[logs.length - 1];
  const nextCursor: SystemLogCursor | undefined = hasMore && last
    ? { timestamp: last.timestamp.toISOString(), id: last.id }
    : undefined;
  return { logs, nextCursor };
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
   * Get a unified, reverse-chronological feed of system logs
   * (responses as info/warning + errors as error) with cursor pagination.
   */
  getSystemLogs(filter?: SystemLogFilter): Promise<SystemLogPage>;

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

