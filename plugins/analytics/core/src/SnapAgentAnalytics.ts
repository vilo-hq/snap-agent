import type {
  AnalyticsPlugin,
  RequestTrackingData,
  ResponseTrackingData,
  ErrorTrackingData,
  PerformanceTimings,
  RAGMetrics,
  TokenMetrics,
} from '@snap-agent/core';

import type {
  AnalyticsStorage,
  StoredRequest,
  StoredResponse,
  StoredError,
} from './storage';
import { MemoryAnalyticsStorage } from './storage';

// ============================================================================
// Configuration
// ============================================================================

export interface AnalyticsConfig {
  /**
   * Enable performance metrics
   * @default true
   */
  enablePerformance?: boolean;

  /**
   * Enable RAG metrics
   * @default true
   */
  enableRAG?: boolean;

  /**
   * Enable cost tracking
   * @default true
   */
  enableCost?: boolean;

  /**
   * Enable conversation metrics
   * @default true
   */
  enableConversation?: boolean;

  /**
   * Enable error tracking
   * @default true
   */
  enableErrors?: boolean;

  /**
   * Cost per 1K tokens by model (for cost calculation)
   * Format: { 'gpt-4o': { input: 0.005, output: 0.015 } }
   */
  modelCosts?: Record<string, { input: number; output: number }>;

  /**
   * Cost per 1K embedding tokens
   * @default 0.0001
   */
  embeddingCost?: number;

  /**
   * Data retention in days (0 = forever)
   * @default 30
   */
  retentionDays?: number;

  /**
   * Flush interval in ms (for batched writes)
   * @default 5000
   */
  flushInterval?: number;

  /**
   * Custom event handler for real-time metrics
   */
  onMetric?: (metric: MetricEvent) => void;

  /**
   * Analytics storage adapter for persistent storage.
   * If not provided, uses in-memory storage (data lost on restart).
   * 
   * @example
   * // Use MongoDB storage
   * import { MongoAnalyticsStorage } from '@snap-agent/analytics/storage';
   * 
   * const analytics = new SnapAgentAnalytics({
   *   storage: new MongoAnalyticsStorage({ uri: process.env.MONGODB_URI! }),
   * });
   */
  storage?: AnalyticsStorage;
}

// ============================================================================
// Metric Types
// ============================================================================

export interface MetricEvent {
  type: 'request' | 'response' | 'error';
  timestamp: Date;
  data: RequestTrackingData | ResponseTrackingData | ErrorTrackingData;
}

/**
 * Data passed to onFlush callback
 */
export interface FlushData {
  requests: StoredRequest[];
  responses: StoredResponse[];
  errors: StoredError[];
  timestamp: Date;
}

/**
 * Performance metrics aggregation
 */
export interface PerformanceMetrics {
  totalRequests: number;
  avgLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  minLatency: number;
  maxLatency: number;

  // Component breakdown
  avgLLMTime: number;
  avgRAGTime: number;
  avgPluginTime: number;
  avgDbTime: number;

  // Streaming
  avgTimeToFirstToken: number;
  avgTimeToLastToken: number;

  // Distribution
  latencyDistribution: {
    under100ms: number;
    under500ms: number;
    under1s: number;
    under5s: number;
    over5s: number;
  };
}

/**
 * RAG metrics aggregation
 */
export interface RAGAnalyticsMetrics {
  totalQueries: number;
  avgDocumentsRetrieved: number;
  avgVectorSearchTime: number;
  avgEmbeddingTime: number;
  cacheHitRate: number;
  cacheMissRate: number;
  avgSimilarityScore: number;
  avgRerankTime: number;
  avgContextLength: number;
  avgContextTokens: number;
  avgSourcesCount: number;
  retrievalSuccessRate: number;
}

/**
 * Cost metrics aggregation
 */
export interface CostMetrics {
  totalCost: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  avgTokensPerRequest: number;
  avgCostPerRequest: number;
  tokenEfficiency: number; // output / input ratio

  // Breakdowns
  costByModel: Record<string, number>;
  costByAgent: Record<string, number>;
  tokensByModel: Record<string, number>;

  // Embedding costs
  totalEmbeddingTokens: number;
  totalEmbeddingCost: number;

  // Time-based
  dailyCosts: Record<string, number>;
}

/**
 * Conversation quality metrics
 */
export interface ConversationMetrics {
  totalThreads: number;
  totalMessages: number;
  avgMessagesPerThread: number;
  avgThreadDuration: number; // ms
  avgSessionLength: number;
  userReturnRate: number;
  threadAbandonmentRate: number; // threads with only 1 message

  // Message characteristics
  avgInputLength: number;
  avgOutputLength: number;
  inputLengthDistribution: {
    short: number;    // < 50 chars
    medium: number;   // 50-200 chars
    long: number;     // 200-500 chars
    veryLong: number; // > 500 chars
  };
}

/**
 * Error metrics aggregation
 */
export interface ErrorMetrics {
  totalErrors: number;
  errorRate: number; // errors / total requests

  // By type
  errorsByType: Record<string, number>;

  // By component
  llmErrors: number;
  ragErrors: number;
  pluginErrors: number;
  dbErrors: number;
  networkErrors: number;
  timeoutErrors: number;
  rateLimitHits: number;

  // Reliability
  successRate: number;
  retryCount: number;
  fallbackUsage: number;

  // Recent errors (last N)
  recentErrors: Array<{
    timestamp: Date;
    type: string;
    message: string;
    agentId: string;
  }>;
}

/**
 * All metrics aggregated
 */
export interface AggregatedMetrics {
  period: {
    start: Date;
    end: Date;
  };
  performance: PerformanceMetrics;
  rag: RAGAnalyticsMetrics;
  cost: CostMetrics;
  conversation: ConversationMetrics;
  errors: ErrorMetrics;
}

/**
 * Time series data point
 */
export interface TimeSeriesMetric {
  timestamp: Date;
  value: number;
  metadata?: Record<string, any>;
}

/**
 * Percentile metrics helper
 */
export interface PercentileMetrics {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
}

// ============================================================================
// Internal Storage Types
// ============================================================================

// StoredRequest, StoredResponse, StoredError are imported from ./storage

interface ThreadStats {
  threadId: string;
  agentId: string;
  userId?: string;
  messageCount: number;
  firstMessage: Date;
  lastMessage: Date;
}

// ============================================================================
// Default Model Costs (per 1K tokens)
// ============================================================================

const DEFAULT_MODEL_COSTS: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-4o': { input: 0.005, output: 0.015 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'gpt-4': { input: 0.03, output: 0.06 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },

  // Anthropic
  'claude-3-5-sonnet-20241022': { input: 0.003, output: 0.015 },
  'claude-3-opus-20240229': { input: 0.015, output: 0.075 },
  'claude-3-sonnet-20240229': { input: 0.003, output: 0.015 },
  'claude-3-haiku-20240307': { input: 0.00025, output: 0.00125 },

  // Google
  'gemini-2.0-flash-exp': { input: 0.0, output: 0.0 }, // Free during preview
  'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
  'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
};

// ============================================================================
// Analytics Plugin Implementation
// ============================================================================

/**
 * SnapAgent Analytics Plugin
 * 
 * Comprehensive analytics tracking for AI agents with 5 metric categories:
 * 1. Performance Metrics - Latency, timing breakdown, percentiles
 * 2. RAG Metrics - Retrieval stats, cache rates, similarity scores
 * 3. Cost & Token Metrics - Usage tracking, cost calculation
 * 4. Conversation Metrics - Engagement, session quality
 * 5. Error Metrics - Error rates, reliability stats
 */
export class SnapAgentAnalytics implements AnalyticsPlugin {
  name = 'snap-agent-analytics';
  type = 'analytics' as const;

  private config: Required<Omit<AnalyticsConfig, 'storage'>> & Pick<AnalyticsConfig, 'storage'>;

  // Persistent storage adapter
  private storage: AnalyticsStorage;

  // In-memory caches (for fast access during aggregation)
  private requests: StoredRequest[] = [];
  private responses: StoredResponse[] = [];
  private errors: StoredError[] = [];
  private threadStats: Map<string, ThreadStats> = new Map();
  private userSessions: Map<string, Date[]> = new Map();

  // Counter for IDs
  private idCounter = 0;

  // Flush mechanism
  private flushTimer?: NodeJS.Timeout;
  private pendingRequests: StoredRequest[] = [];
  private pendingResponses: StoredResponse[] = [];
  private pendingErrors: StoredError[] = [];
  private isFlushing = false;

  constructor(config: AnalyticsConfig = {}) {
    this.config = {
      enablePerformance: config.enablePerformance !== false,
      enableRAG: config.enableRAG !== false,
      enableCost: config.enableCost !== false,
      enableConversation: config.enableConversation !== false,
      enableErrors: config.enableErrors !== false,
      modelCosts: { ...DEFAULT_MODEL_COSTS, ...config.modelCosts },
      embeddingCost: config.embeddingCost ?? 0.0001,
      retentionDays: config.retentionDays ?? 30,
      flushInterval: config.flushInterval ?? 5000,
      onMetric: config.onMetric || (() => { }),
      storage: config.storage,
    };

    // Initialize storage adapter (default to in-memory)
    this.storage = config.storage || new MemoryAnalyticsStorage();

    // Start cleanup timer if retention is set
    if (this.config.retentionDays > 0) {
      setInterval(() => this.cleanup(), 60 * 60 * 1000);
    }

    // Start flush timer for persistent storage or legacy onFlush callback
    if ((this.config.storage) && this.config.flushInterval > 0) {
      this.startFlushTimer();
    }
  }

  // ============================================================================
  // Basic Interface (Backwards Compatible)
  // ============================================================================

  /**
   * Track incoming request (basic)
   */
  async trackRequest(data: {
    agentId: string;
    threadId?: string;
    message: string;
    timestamp: Date;
  }): Promise<void> {
    await this.trackRequestExtended({
      agentId: data.agentId,
      threadId: data.threadId,
      message: data.message,
      messageLength: data.message.length,
      timestamp: data.timestamp,
    });
  }

  /**
   * Track response (basic)
   */
  async trackResponse(data: {
    agentId: string;
    threadId?: string;
    response: string;
    latency: number;
    tokensUsed?: number;
    timestamp: Date;
  }): Promise<void> {
    await this.trackResponseExtended({
      agentId: data.agentId,
      threadId: data.threadId,
      response: data.response,
      responseLength: data.response.length,
      timestamp: data.timestamp,
      timings: { total: data.latency },
      tokens: {
        promptTokens: 0,
        completionTokens: data.tokensUsed || 0,
        totalTokens: data.tokensUsed || 0,
      },
      success: true,
    });
  }

  // ============================================================================
  // Extended Interface
  // ============================================================================

  /**
   * Track request with full metadata
   */
  async trackRequestExtended(data: RequestTrackingData): Promise<void> {
    const request: StoredRequest = {
      id: `req-${++this.idCounter}`,
      agentId: data.agentId,
      threadId: data.threadId,
      userId: data.userId,
      timestamp: data.timestamp,
      messageLength: data.messageLength,
      model: data.model,
      provider: data.provider,
    };

    this.requests.push(request);
    this.pendingRequests.push(request);

    // Update conversation stats
    if (this.config.enableConversation && data.threadId) {
      this.updateThreadStats(data.threadId, data.agentId, data.userId, data.timestamp);
    }

    // Track user session
    if (data.userId) {
      this.trackUserSession(data.userId, data.timestamp);
    }

    // Emit event
    this.config.onMetric({
      type: 'request',
      timestamp: data.timestamp,
      data,
    });
  }

  /**
   * Track response with full metrics
   */
  async trackResponseExtended(data: ResponseTrackingData): Promise<void> {
    // Calculate cost
    let estimatedCost = 0;
    if (this.config.enableCost && data.model) {
      estimatedCost = this.calculateCost(
        data.model,
        data.tokens.promptTokens,
        data.tokens.completionTokens,
        data.rag?.contextTokens
      );
    }

    const response: StoredResponse = {
      id: `res-${++this.idCounter}`,
      requestId: `req-${this.idCounter}`,
      agentId: data.agentId,
      threadId: data.threadId,
      userId: data.userId,
      timestamp: data.timestamp,
      responseLength: data.responseLength,
      timings: data.timings,
      tokens: {
        ...data.tokens,
        estimatedCost,
      },
      rag: data.rag,
      success: data.success,
      errorType: data.errorType,
      model: data.model,
      provider: data.provider,
    };

    this.responses.push(response);
    this.pendingResponses.push(response);

    // Update conversation stats
    if (this.config.enableConversation && data.threadId) {
      this.updateThreadStats(data.threadId, data.agentId, data.userId, data.timestamp);
    }

    // Track error if not successful
    if (!data.success && data.errorType) {
      await this.trackError({
        agentId: data.agentId,
        threadId: data.threadId,
        timestamp: data.timestamp,
        errorType: data.errorType,
        errorMessage: data.errorMessage || 'Unknown error',
        component: 'llm',
      });
    }

    // Emit event
    this.config.onMetric({
      type: 'response',
      timestamp: data.timestamp,
      data,
    });
  }

  /**
   * Track errors
   */
  async trackError(data: ErrorTrackingData): Promise<void> {
    if (!this.config.enableErrors) return;

    const error: StoredError = {
      id: `err-${++this.idCounter}`,
      agentId: data.agentId,
      threadId: data.threadId,
      timestamp: data.timestamp,
      errorType: data.errorType,
      errorMessage: data.errorMessage,
      component: data.component,
    };

    this.errors.push(error);
    this.pendingErrors.push(error);

    // Emit event
    this.config.onMetric({
      type: 'error',
      timestamp: data.timestamp,
      data,
    });
  }

  // ============================================================================
  // Metrics Retrieval
  // ============================================================================

  /**
   * Get aggregated metrics
   */
  async getMetrics(options?: {
    agentId?: string;
    startDate?: Date;
    endDate?: Date;
    groupBy?: 'hour' | 'day' | 'week' | 'month';
  }): Promise<AggregatedMetrics> {
    const startDate = options?.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = options?.endDate || new Date();

    // Filter data by date range and agent
    const filteredResponses = this.filterResponses(options?.agentId, startDate, endDate);
    const filteredRequests = this.filterRequests(options?.agentId, startDate, endDate);
    const filteredErrors = this.filterErrors(options?.agentId, startDate, endDate);

    return {
      period: { start: startDate, end: endDate },
      performance: this.calculatePerformanceMetrics(filteredResponses),
      rag: this.calculateRAGMetrics(filteredResponses),
      cost: this.calculateCostMetrics(filteredResponses),
      conversation: this.calculateConversationMetrics(filteredRequests, options?.agentId),
      errors: this.calculateErrorMetrics(filteredErrors, filteredResponses.length),
    };
  }

  /**
   * Get performance metrics
   */
  getPerformanceMetrics(options?: {
    agentId?: string;
    startDate?: Date;
    endDate?: Date;
  }): PerformanceMetrics {
    const responses = this.filterResponses(
      options?.agentId,
      options?.startDate,
      options?.endDate
    );
    return this.calculatePerformanceMetrics(responses);
  }

  /**
   * Get RAG metrics
   */
  getRAGMetrics(options?: {
    agentId?: string;
    startDate?: Date;
    endDate?: Date;
  }): RAGAnalyticsMetrics {
    const responses = this.filterResponses(
      options?.agentId,
      options?.startDate,
      options?.endDate
    );
    return this.calculateRAGMetrics(responses);
  }

  /**
   * Get cost metrics
   */
  getCostMetrics(options?: {
    agentId?: string;
    startDate?: Date;
    endDate?: Date;
  }): CostMetrics {
    const responses = this.filterResponses(
      options?.agentId,
      options?.startDate,
      options?.endDate
    );
    return this.calculateCostMetrics(responses);
  }

  /**
   * Get conversation metrics
   */
  getConversationMetrics(options?: {
    agentId?: string;
    startDate?: Date;
    endDate?: Date;
  }): ConversationMetrics {
    const requests = this.filterRequests(
      options?.agentId,
      options?.startDate,
      options?.endDate
    );
    return this.calculateConversationMetrics(requests, options?.agentId);
  }

  /**
   * Get error metrics
   */
  getErrorMetrics(options?: {
    agentId?: string;
    startDate?: Date;
    endDate?: Date;
  }): ErrorMetrics {
    const errors = this.filterErrors(
      options?.agentId,
      options?.startDate,
      options?.endDate
    );
    const responses = this.filterResponses(
      options?.agentId,
      options?.startDate,
      options?.endDate
    );
    return this.calculateErrorMetrics(errors, responses.length);
  }

  /**
   * Get time series data
   */
  getTimeSeries(
    metric: 'latency' | 'tokens' | 'cost' | 'errors' | 'requests',
    options?: {
      agentId?: string;
      startDate?: Date;
      endDate?: Date;
      groupBy?: 'hour' | 'day' | 'week';
    }
  ): TimeSeriesMetric[] {
    const groupBy = options?.groupBy || 'day';
    const responses = this.filterResponses(
      options?.agentId,
      options?.startDate,
      options?.endDate
    );

    // Group by time period
    const groups = new Map<string, StoredResponse[]>();

    for (const response of responses) {
      const key = this.getTimeKey(response.timestamp, groupBy);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(response);
    }

    // Calculate metric for each group
    const series: TimeSeriesMetric[] = [];

    for (const [key, groupResponses] of groups.entries()) {
      let value = 0;

      switch (metric) {
        case 'latency':
          value = this.avg(groupResponses.map((r) => r.timings.total));
          break;
        case 'tokens':
          value = groupResponses.reduce((sum, r) => sum + r.tokens.totalTokens, 0);
          break;
        case 'cost':
          value = groupResponses.reduce((sum, r) => sum + (r.tokens.estimatedCost || 0), 0);
          break;
        case 'errors':
          value = groupResponses.filter((r) => !r.success).length;
          break;
        case 'requests':
          value = groupResponses.length;
          break;
      }

      series.push({
        timestamp: new Date(key),
        value,
        metadata: { count: groupResponses.length },
      });
    }

    return series.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  // ============================================================================
  // Private: Calculation Methods
  // ============================================================================

  private calculatePerformanceMetrics(responses: StoredResponse[]): PerformanceMetrics {
    if (responses.length === 0) {
      return this.emptyPerformanceMetrics();
    }

    const latencies = responses.map((r) => r.timings.total);
    const sorted = [...latencies].sort((a, b) => a - b);

    const llmTimes = responses.map((r) => r.timings.llmApiTime).filter(Boolean) as number[];
    const ragTimes = responses.map((r) => r.timings.ragRetrievalTime).filter(Boolean) as number[];
    const pluginTimes = responses.map((r) => r.timings.pluginExecutionTime).filter(Boolean) as number[];
    const dbTimes = responses.map((r) => r.timings.dbQueryTime).filter(Boolean) as number[];
    const ttft = responses.map((r) => r.timings.timeToFirstToken).filter(Boolean) as number[];
    const ttlt = responses.map((r) => r.timings.timeToLastToken).filter(Boolean) as number[];

    return {
      totalRequests: responses.length,
      avgLatency: this.avg(latencies),
      p50Latency: this.percentile(sorted, 50),
      p95Latency: this.percentile(sorted, 95),
      p99Latency: this.percentile(sorted, 99),
      minLatency: Math.min(...latencies),
      maxLatency: Math.max(...latencies),
      avgLLMTime: this.avg(llmTimes),
      avgRAGTime: this.avg(ragTimes),
      avgPluginTime: this.avg(pluginTimes),
      avgDbTime: this.avg(dbTimes),
      avgTimeToFirstToken: this.avg(ttft),
      avgTimeToLastToken: this.avg(ttlt),
      latencyDistribution: {
        under100ms: latencies.filter((l) => l < 100).length,
        under500ms: latencies.filter((l) => l >= 100 && l < 500).length,
        under1s: latencies.filter((l) => l >= 500 && l < 1000).length,
        under5s: latencies.filter((l) => l >= 1000 && l < 5000).length,
        over5s: latencies.filter((l) => l >= 5000).length,
      },
    };
  }

  private calculateRAGMetrics(responses: StoredResponse[]): RAGAnalyticsMetrics {
    const ragResponses = responses.filter((r) => r.rag?.enabled);

    if (ragResponses.length === 0) {
      return this.emptyRAGMetrics();
    }

    const docsRetrieved = ragResponses.map((r) => r.rag!.documentsRetrieved || 0);
    const vectorTimes = ragResponses.map((r) => r.rag!.vectorSearchTime).filter(Boolean) as number[];
    const embedTimes = ragResponses.map((r) => r.rag!.embeddingTime).filter(Boolean) as number[];
    const similarities = ragResponses.map((r) => r.rag!.avgSimilarityScore).filter(Boolean) as number[];
    const rerankTimes = ragResponses.map((r) => r.rag!.rerankTime).filter(Boolean) as number[];
    const contextLengths = ragResponses.map((r) => r.rag!.contextLength).filter(Boolean) as number[];
    const contextTokens = ragResponses.map((r) => r.rag!.contextTokens).filter(Boolean) as number[];
    const sourcesCounts = ragResponses.map((r) => r.rag!.sourcesCount).filter(Boolean) as number[];

    const cacheHits = ragResponses.filter((r) => r.rag!.cacheHit === true).length;
    const cacheMisses = ragResponses.filter((r) => r.rag!.cacheHit === false).length;
    const successfulRetrievals = ragResponses.filter((r) => (r.rag!.documentsRetrieved || 0) > 0).length;

    return {
      totalQueries: ragResponses.length,
      avgDocumentsRetrieved: this.avg(docsRetrieved),
      avgVectorSearchTime: this.avg(vectorTimes),
      avgEmbeddingTime: this.avg(embedTimes),
      cacheHitRate: cacheHits / (cacheHits + cacheMisses) || 0,
      cacheMissRate: cacheMisses / (cacheHits + cacheMisses) || 0,
      avgSimilarityScore: this.avg(similarities),
      avgRerankTime: this.avg(rerankTimes),
      avgContextLength: this.avg(contextLengths),
      avgContextTokens: this.avg(contextTokens),
      avgSourcesCount: this.avg(sourcesCounts),
      retrievalSuccessRate: successfulRetrievals / ragResponses.length,
    };
  }

  private calculateCostMetrics(responses: StoredResponse[]): CostMetrics {
    if (responses.length === 0) {
      return this.emptyCostMetrics();
    }

    const totalCost = responses.reduce((sum, r) => sum + (r.tokens.estimatedCost || 0), 0);
    const totalTokens = responses.reduce((sum, r) => sum + r.tokens.totalTokens, 0);
    const totalPromptTokens = responses.reduce((sum, r) => sum + r.tokens.promptTokens, 0);
    const totalCompletionTokens = responses.reduce((sum, r) => sum + r.tokens.completionTokens, 0);
    const totalEmbeddingTokens = responses.reduce((sum, r) => sum + (r.rag?.contextTokens || 0), 0);
    const totalEmbeddingCost = totalEmbeddingTokens * this.config.embeddingCost / 1000;

    // Group by model
    const costByModel: Record<string, number> = {};
    const tokensByModel: Record<string, number> = {};
    for (const r of responses) {
      const model = r.model || 'unknown';
      costByModel[model] = (costByModel[model] || 0) + (r.tokens.estimatedCost || 0);
      tokensByModel[model] = (tokensByModel[model] || 0) + r.tokens.totalTokens;
    }

    // Group by agent
    const costByAgent: Record<string, number> = {};
    for (const r of responses) {
      costByAgent[r.agentId] = (costByAgent[r.agentId] || 0) + (r.tokens.estimatedCost || 0);
    }

    // Daily costs
    const dailyCosts: Record<string, number> = {};
    for (const r of responses) {
      const day = r.timestamp.toISOString().split('T')[0];
      dailyCosts[day] = (dailyCosts[day] || 0) + (r.tokens.estimatedCost || 0);
    }

    return {
      totalCost,
      totalTokens,
      totalPromptTokens,
      totalCompletionTokens,
      avgTokensPerRequest: totalTokens / responses.length,
      avgCostPerRequest: totalCost / responses.length,
      tokenEfficiency: totalCompletionTokens / (totalPromptTokens || 1),
      costByModel,
      costByAgent,
      tokensByModel,
      totalEmbeddingTokens,
      totalEmbeddingCost,
      dailyCosts,
    };
  }

  private calculateConversationMetrics(
    requests: StoredRequest[],
    agentId?: string
  ): ConversationMetrics {
    // Filter thread stats
    const relevantThreads = agentId
      ? Array.from(this.threadStats.values()).filter((t) => t.agentId === agentId)
      : Array.from(this.threadStats.values());

    if (relevantThreads.length === 0) {
      return this.emptyConversationMetrics();
    }

    const messageCounts = relevantThreads.map((t) => t.messageCount);
    const durations = relevantThreads.map(
      (t) => t.lastMessage.getTime() - t.firstMessage.getTime()
    );
    const abandonedThreads = relevantThreads.filter((t) => t.messageCount === 1);

    // Input lengths from requests
    const inputLengths = requests.map((r) => r.messageLength);
    const shortInputs = inputLengths.filter((l) => l < 50).length;
    const mediumInputs = inputLengths.filter((l) => l >= 50 && l < 200).length;
    const longInputs = inputLengths.filter((l) => l >= 200 && l < 500).length;
    const veryLongInputs = inputLengths.filter((l) => l >= 500).length;

    // User return rate
    let returnRate = 0;
    if (this.userSessions.size > 0) {
      const returningUsers = Array.from(this.userSessions.values()).filter(
        (sessions) => sessions.length > 1
      ).length;
      returnRate = returningUsers / this.userSessions.size;
    }

    return {
      totalThreads: relevantThreads.length,
      totalMessages: messageCounts.reduce((a, b) => a + b, 0),
      avgMessagesPerThread: this.avg(messageCounts),
      avgThreadDuration: this.avg(durations),
      avgSessionLength: this.avg(durations), // Same as thread duration for now
      userReturnRate: returnRate,
      threadAbandonmentRate: abandonedThreads.length / relevantThreads.length,
      avgInputLength: this.avg(inputLengths),
      avgOutputLength: 0, // Would need to track from responses
      inputLengthDistribution: {
        short: shortInputs,
        medium: mediumInputs,
        long: longInputs,
        veryLong: veryLongInputs,
      },
    };
  }

  private calculateErrorMetrics(
    errors: StoredError[],
    totalRequests: number
  ): ErrorMetrics {
    const errorsByType: Record<string, number> = {};
    for (const e of errors) {
      errorsByType[e.errorType] = (errorsByType[e.errorType] || 0) + 1;
    }

    const llmErrors = errors.filter((e) => e.component === 'llm').length;
    const ragErrors = errors.filter((e) => e.component === 'rag').length;
    const pluginErrors = errors.filter((e) => e.component === 'plugin').length;
    const dbErrors = errors.filter((e) => e.component === 'database').length;
    const networkErrors = errors.filter((e) => e.component === 'network').length;
    const timeoutErrors = errors.filter((e) => e.errorType === 'timeout').length;
    const rateLimitHits = errors.filter((e) => e.errorType === 'rate_limit').length;

    const recentErrors = errors
      .slice(-10)
      .reverse()
      .map((e) => ({
        timestamp: e.timestamp,
        type: e.errorType,
        message: e.errorMessage,
        agentId: e.agentId,
      }));

    return {
      totalErrors: errors.length,
      errorRate: totalRequests > 0 ? errors.length / totalRequests : 0,
      errorsByType,
      llmErrors,
      ragErrors,
      pluginErrors,
      dbErrors,
      networkErrors,
      timeoutErrors,
      rateLimitHits,
      successRate: totalRequests > 0 ? (totalRequests - errors.length) / totalRequests : 1,
      retryCount: 0, // Would need to track this separately
      fallbackUsage: 0, // Would need to track this separately
      recentErrors,
    };
  }

  // ============================================================================
  // Private: Helper Methods
  // ============================================================================

  private calculateCost(
    model: string,
    promptTokens: number,
    completionTokens: number,
    embeddingTokens?: number
  ): number {
    const modelCost = this.config.modelCosts[model];
    if (!modelCost) return 0;

    const inputCost = (promptTokens / 1000) * modelCost.input;
    const outputCost = (completionTokens / 1000) * modelCost.output;
    const embedCost = embeddingTokens
      ? (embeddingTokens / 1000) * this.config.embeddingCost
      : 0;

    return inputCost + outputCost + embedCost;
  }

  private updateThreadStats(
    threadId: string,
    agentId: string,
    userId: string | undefined,
    timestamp: Date
  ): void {
    const existing = this.threadStats.get(threadId);

    if (existing) {
      existing.messageCount++;
      existing.lastMessage = timestamp;
    } else {
      this.threadStats.set(threadId, {
        threadId,
        agentId,
        userId,
        messageCount: 1,
        firstMessage: timestamp,
        lastMessage: timestamp,
      });
    }
  }

  private trackUserSession(userId: string, timestamp: Date): void {
    const sessions = this.userSessions.get(userId) || [];
    sessions.push(timestamp);
    this.userSessions.set(userId, sessions);
  }

  private filterResponses(
    agentId?: string,
    startDate?: Date,
    endDate?: Date
  ): StoredResponse[] {
    return this.responses.filter((r) => {
      if (agentId && r.agentId !== agentId) return false;
      if (startDate && r.timestamp < startDate) return false;
      if (endDate && r.timestamp > endDate) return false;
      return true;
    });
  }

  private filterRequests(
    agentId?: string,
    startDate?: Date,
    endDate?: Date
  ): StoredRequest[] {
    return this.requests.filter((r) => {
      if (agentId && r.agentId !== agentId) return false;
      if (startDate && r.timestamp < startDate) return false;
      if (endDate && r.timestamp > endDate) return false;
      return true;
    });
  }

  private filterErrors(
    agentId?: string,
    startDate?: Date,
    endDate?: Date
  ): StoredError[] {
    return this.errors.filter((e) => {
      if (agentId && e.agentId !== agentId) return false;
      if (startDate && e.timestamp < startDate) return false;
      if (endDate && e.timestamp > endDate) return false;
      return true;
    });
  }

  private getTimeKey(date: Date, groupBy: 'hour' | 'day' | 'week'): string {
    const d = new Date(date);

    switch (groupBy) {
      case 'hour':
        d.setMinutes(0, 0, 0);
        return d.toISOString();
      case 'day':
        d.setHours(0, 0, 0, 0);
        return d.toISOString();
      case 'week':
        const day = d.getDay();
        d.setDate(d.getDate() - day);
        d.setHours(0, 0, 0, 0);
        return d.toISOString();
      default:
        return d.toISOString();
    }
  }

  private avg(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    return numbers.reduce((a, b) => a + b, 0) / numbers.length;
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  private async cleanup(): Promise<void> {
    if (this.config.retentionDays <= 0) return;

    const cutoff = new Date(Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000);

    // Clean up in-memory cache
    this.requests = this.requests.filter((r) => r.timestamp > cutoff);
    this.responses = this.responses.filter((r) => r.timestamp > cutoff);
    this.errors = this.errors.filter((e) => e.timestamp > cutoff);

    // Cleanup thread stats for threads with no recent activity
    for (const [threadId, stats] of this.threadStats.entries()) {
      if (stats.lastMessage < cutoff) {
        this.threadStats.delete(threadId);
      }
    }

    // Clean up persistent storage
    if (this.config.storage) {
      await this.storage.deleteOlderThan(cutoff);
    }
  }

  // Empty metrics for when there's no data
  private emptyPerformanceMetrics(): PerformanceMetrics {
    return {
      totalRequests: 0,
      avgLatency: 0,
      p50Latency: 0,
      p95Latency: 0,
      p99Latency: 0,
      minLatency: 0,
      maxLatency: 0,
      avgLLMTime: 0,
      avgRAGTime: 0,
      avgPluginTime: 0,
      avgDbTime: 0,
      avgTimeToFirstToken: 0,
      avgTimeToLastToken: 0,
      latencyDistribution: { under100ms: 0, under500ms: 0, under1s: 0, under5s: 0, over5s: 0 },
    };
  }

  private emptyRAGMetrics(): RAGAnalyticsMetrics {
    return {
      totalQueries: 0,
      avgDocumentsRetrieved: 0,
      avgVectorSearchTime: 0,
      avgEmbeddingTime: 0,
      cacheHitRate: 0,
      cacheMissRate: 0,
      avgSimilarityScore: 0,
      avgRerankTime: 0,
      avgContextLength: 0,
      avgContextTokens: 0,
      avgSourcesCount: 0,
      retrievalSuccessRate: 0,
    };
  }

  private emptyCostMetrics(): CostMetrics {
    return {
      totalCost: 0,
      totalTokens: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      avgTokensPerRequest: 0,
      avgCostPerRequest: 0,
      tokenEfficiency: 0,
      costByModel: {},
      costByAgent: {},
      tokensByModel: {},
      totalEmbeddingTokens: 0,
      totalEmbeddingCost: 0,
      dailyCosts: {},
    };
  }

  private emptyConversationMetrics(): ConversationMetrics {
    return {
      totalThreads: 0,
      totalMessages: 0,
      avgMessagesPerThread: 0,
      avgThreadDuration: 0,
      avgSessionLength: 0,
      userReturnRate: 0,
      threadAbandonmentRate: 0,
      avgInputLength: 0,
      avgOutputLength: 0,
      inputLengthDistribution: { short: 0, medium: 0, long: 0, veryLong: 0 },
    };
  }

  // ============================================================================
  // Public: Utility Methods
  // ============================================================================

  /**
   * Get raw data for export
   */
  exportData(): {
    requests: StoredRequest[];
    responses: StoredResponse[];
    errors: StoredError[];
  } {
    return {
      requests: [...this.requests],
      responses: [...this.responses],
      errors: [...this.errors],
    };
  }

  /**
   * Clear all analytics data
   */
  clear(): void {
    this.requests = [];
    this.responses = [];
    this.errors = [];
    this.pendingRequests = [];
    this.pendingResponses = [];
    this.pendingErrors = [];
    this.threadStats.clear();
    this.userSessions.clear();
  }

  /**
   * Get summary statistics
   */
  getSummary(): Record<string, any> {
    return {
      totalRequests: this.requests.length,
      totalResponses: this.responses.length,
      totalErrors: this.errors.length,
      totalThreads: this.threadStats.size,
      totalUsers: this.userSessions.size,
      dataRange: {
        oldest: this.requests[0]?.timestamp,
        newest: this.requests[this.requests.length - 1]?.timestamp,
      },
    };
  }

  // ============================================================================
  // Flush Mechanism
  // ============================================================================

  /**
   * Start the flush timer
   */
  private startFlushTimer(): void {
    if (this.flushTimer) {
      return; // Already running
    }
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error('[SnapAgentAnalytics] Flush error:', err);
      });
    }, this.config.flushInterval);
  }

  /**
   * Stop the flush timer
   */
  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /**
   * Flush pending data to external storage via onFlush callback
   * @returns Promise that resolves when flush is complete
   */
  async flush(): Promise<void> {
    if (this.isFlushing) {
      return; // Already flushing
    }

    // Nothing to flush
    if (
      this.pendingRequests.length === 0 &&
      this.pendingResponses.length === 0 &&
      this.pendingErrors.length === 0
    ) {
      return;
    }

    this.isFlushing = true;

    try {
      // Capture pending data
      const flushData: FlushData = {
        requests: [...this.pendingRequests],
        responses: [...this.pendingResponses],
        errors: [...this.pendingErrors],
        timestamp: new Date(),
      };

      // Clear pending arrays before calling callback
      // (so new data during callback goes to next batch)
      this.pendingRequests = [];
      this.pendingResponses = [];
      this.pendingErrors = [];

      // Save to storage adapter
      if (this.config.storage) {
        await Promise.all([
          this.storage.saveRequests(flushData.requests),
          this.storage.saveResponses(flushData.responses),
          this.storage.saveErrors(flushData.errors),
        ]);
      }

    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Stop the analytics plugin and flush remaining data
   * Call this before shutting down to ensure all data is persisted
   */
  async stop(): Promise<void> {
    this.stopFlushTimer();
    await this.flush();
    await this.storage.close();
  }

  /**
   * Get count of pending (unflushed) items
   */
  getPendingCount(): { requests: number; responses: number; errors: number } {
    return {
      requests: this.pendingRequests.length,
      responses: this.pendingResponses.length,
      errors: this.pendingErrors.length,
    };
  }
}

