import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SnapAgentAnalytics, AnalyticsConfig } from '../src/SnapAgentAnalytics';
import { MemoryAnalyticsStorage } from '../src/storage/MemoryAnalyticsStorage';

describe('SnapAgentAnalytics', () => {
  let analytics: SnapAgentAnalytics;

  beforeEach(() => {
    vi.useFakeTimers();
    analytics = new SnapAgentAnalytics();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // Constructor Tests
  // ==========================================================================

  describe('constructor', () => {
    it('should create analytics with default config', () => {
      const a = new SnapAgentAnalytics();
      expect(a).toBeInstanceOf(SnapAgentAnalytics);
      expect(a.name).toBe('snap-agent-analytics');
      expect(a.type).toBe('analytics');
    });

    it('should accept custom config', () => {
      const config: AnalyticsConfig = {
        enablePerformance: true,
        enableRAG: false,
        enableCost: true,
        retentionDays: 7,
        flushInterval: 10000,
      };
      const a = new SnapAgentAnalytics(config);
      expect(a).toBeInstanceOf(SnapAgentAnalytics);
    });

    it('should accept custom model costs', () => {
      const a = new SnapAgentAnalytics({
        modelCosts: {
          'custom-model': { input: 0.01, output: 0.02 },
        },
      });
      expect(a).toBeInstanceOf(SnapAgentAnalytics);
    });

    it('should use custom storage adapter', () => {
      const storage = new MemoryAnalyticsStorage();
      const a = new SnapAgentAnalytics({ storage });
      expect(a).toBeInstanceOf(SnapAgentAnalytics);
    });
  });

  // ==========================================================================
  // Basic Tracking Tests
  // ==========================================================================

  describe('trackRequest', () => {
    it('should track a basic request', async () => {
      await analytics.trackRequest({
        agentId: 'agent-1',
        threadId: 'thread-1',
        message: 'Hello, world!',
        timestamp: new Date(),
      });

      const summary = analytics.getSummary();
      expect(summary.totalRequests).toBe(1);
    });

    it('should track multiple requests', async () => {
      for (let i = 0; i < 5; i++) {
        await analytics.trackRequest({
          agentId: 'agent-1',
          message: `Message ${i}`,
          timestamp: new Date(),
        });
      }

      const summary = analytics.getSummary();
      expect(summary.totalRequests).toBe(5);
    });
  });

  describe('trackResponse', () => {
    it('should track a basic response', async () => {
      await analytics.trackResponse({
        agentId: 'agent-1',
        threadId: 'thread-1',
        response: 'Hello! How can I help you?',
        latency: 250,
        tokensUsed: 50,
        timestamp: new Date(),
      });

      const summary = analytics.getSummary();
      expect(summary.totalResponses).toBe(1);
    });

    it('should track response with token metrics', async () => {
      await analytics.trackResponse({
        agentId: 'agent-1',
        response: 'Response text',
        latency: 500,
        tokensUsed: 100,
        timestamp: new Date(),
      });

      const costMetrics = analytics.getCostMetrics();
      expect(costMetrics.totalTokens).toBe(100);
    });
  });

  // ==========================================================================
  // Extended Tracking Tests
  // ==========================================================================

  describe('trackRequestExtended', () => {
    it('should track extended request data', async () => {
      await analytics.trackRequestExtended({
        agentId: 'agent-1',
        threadId: 'thread-1',
        userId: 'user-1',
        message: 'Complex query',
        messageLength: 13,
        timestamp: new Date(),
        model: 'gpt-4o',
        provider: 'openai',
      });

      const summary = analytics.getSummary();
      expect(summary.totalRequests).toBe(1);
    });

    it('should update thread stats', async () => {
      await analytics.trackRequestExtended({
        agentId: 'agent-1',
        threadId: 'thread-1',
        message: 'First message',
        messageLength: 13,
        timestamp: new Date(),
      });

      await analytics.trackRequestExtended({
        agentId: 'agent-1',
        threadId: 'thread-1',
        message: 'Second message',
        messageLength: 14,
        timestamp: new Date(),
      });

      const convMetrics = analytics.getConversationMetrics();
      expect(convMetrics.totalThreads).toBe(1);
      expect(convMetrics.avgMessagesPerThread).toBe(2);
    });
  });

  describe('trackResponseExtended', () => {
    it('should track full response metrics', async () => {
      await analytics.trackResponseExtended({
        agentId: 'agent-1',
        threadId: 'thread-1',
        userId: 'user-1',
        response: 'Detailed response',
        responseLength: 17,
        timestamp: new Date(),
        timings: {
          total: 500,
          llmApiTime: 400,
          ragRetrievalTime: 80,
          pluginExecutionTime: 15,
          dbQueryTime: 5,
        },
        tokens: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        },
        success: true,
        model: 'gpt-4o',
        provider: 'openai',
      });

      const perfMetrics = analytics.getPerformanceMetrics();
      expect(perfMetrics.totalRequests).toBe(1);
      expect(perfMetrics.avgLatency).toBe(500);
    });

    it('should track RAG metrics', async () => {
      await analytics.trackResponseExtended({
        agentId: 'agent-1',
        response: 'RAG response',
        responseLength: 12,
        timestamp: new Date(),
        timings: { total: 300 },
        tokens: {
          promptTokens: 200,
          completionTokens: 50,
          totalTokens: 250,
        },
        rag: {
          enabled: true,
          documentsRetrieved: 5,
          vectorSearchTime: 45,
          embeddingTime: 30,
          cacheHit: true,
          avgSimilarityScore: 0.85,
          contextLength: 2000,
          contextTokens: 500,
          sourcesCount: 4,
        },
        success: true,
        model: 'gpt-4o',
      });

      const ragMetrics = analytics.getRAGMetrics();
      expect(ragMetrics.totalQueries).toBe(1);
      expect(ragMetrics.avgDocumentsRetrieved).toBe(5);
      expect(ragMetrics.cacheHitRate).toBe(1);
    });

    it('should calculate cost for known models', async () => {
      await analytics.trackResponseExtended({
        agentId: 'agent-1',
        response: 'Response',
        responseLength: 8,
        timestamp: new Date(),
        timings: { total: 200 },
        tokens: {
          promptTokens: 1000, // 1K tokens
          completionTokens: 500, // 0.5K tokens
          totalTokens: 1500,
        },
        success: true,
        model: 'gpt-4o', // $0.005/1K input, $0.015/1K output
      });

      const costMetrics = analytics.getCostMetrics();
      // Expected: (1 * 0.005) + (0.5 * 0.015) = 0.005 + 0.0075 = 0.0125
      expect(costMetrics.totalCost).toBeCloseTo(0.0125, 4);
    });
  });

  describe('trackError', () => {
    it('should track errors', async () => {
      await analytics.trackError({
        agentId: 'agent-1',
        threadId: 'thread-1',
        timestamp: new Date(),
        errorType: 'rate_limit',
        errorMessage: 'Too many requests',
        component: 'llm',
      });

      const errorMetrics = analytics.getErrorMetrics();
      expect(errorMetrics.totalErrors).toBe(1);
      expect(errorMetrics.rateLimitHits).toBe(1);
      expect(errorMetrics.llmErrors).toBe(1);
    });

    it('should categorize errors by type', async () => {
      await analytics.trackError({
        agentId: 'agent-1',
        timestamp: new Date(),
        errorType: 'timeout',
        errorMessage: 'Request timed out',
        component: 'network',
      });

      await analytics.trackError({
        agentId: 'agent-1',
        timestamp: new Date(),
        errorType: 'rate_limit',
        errorMessage: 'Rate limited',
        component: 'llm',
      });

      const errorMetrics = analytics.getErrorMetrics();
      expect(errorMetrics.errorsByType).toEqual({
        timeout: 1,
        rate_limit: 1,
      });
    });
  });

  // ==========================================================================
  // Metrics Calculation Tests
  // ==========================================================================

  describe('getPerformanceMetrics', () => {
    beforeEach(async () => {
      // Add some test responses
      const latencies = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
      for (const latency of latencies) {
        await analytics.trackResponseExtended({
          agentId: 'agent-1',
          response: 'Response',
          responseLength: 8,
          timestamp: new Date(),
          timings: { total: latency },
          tokens: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
          success: true,
        });
      }
    });

    it('should calculate average latency', () => {
      const metrics = analytics.getPerformanceMetrics();
      expect(metrics.avgLatency).toBe(550); // Average of 100-1000
    });

    it('should calculate percentiles', () => {
      const metrics = analytics.getPerformanceMetrics();
      expect(metrics.p50Latency).toBe(500);
      expect(metrics.p95Latency).toBe(1000);
      expect(metrics.minLatency).toBe(100);
      expect(metrics.maxLatency).toBe(1000);
    });

    it('should calculate latency distribution', () => {
      const metrics = analytics.getPerformanceMetrics();
      expect(metrics.latencyDistribution.under100ms).toBe(0);
      expect(metrics.latencyDistribution.under500ms).toBe(4); // 100, 200, 300, 400
      expect(metrics.latencyDistribution.under1s).toBe(5); // 500, 600, 700, 800, 900
      expect(metrics.latencyDistribution.under5s).toBe(1); // 1000
    });

    it('should filter by agentId', async () => {
      await analytics.trackResponseExtended({
        agentId: 'agent-2',
        response: 'Response',
        responseLength: 8,
        timestamp: new Date(),
        timings: { total: 50 },
        tokens: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
        success: true,
      });

      const metrics = analytics.getPerformanceMetrics({ agentId: 'agent-2' });
      expect(metrics.totalRequests).toBe(1);
      expect(metrics.avgLatency).toBe(50);
    });
  });

  describe('getCostMetrics', () => {
    it('should aggregate costs by model', async () => {
      await analytics.trackResponseExtended({
        agentId: 'agent-1',
        response: 'Response',
        responseLength: 8,
        timestamp: new Date(),
        timings: { total: 200 },
        tokens: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
        success: true,
        model: 'gpt-4o',
      });

      await analytics.trackResponseExtended({
        agentId: 'agent-1',
        response: 'Response',
        responseLength: 8,
        timestamp: new Date(),
        timings: { total: 200 },
        tokens: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
        success: true,
        model: 'gpt-4o-mini',
      });

      const metrics = analytics.getCostMetrics();
      expect(Object.keys(metrics.costByModel)).toContain('gpt-4o');
      expect(Object.keys(metrics.costByModel)).toContain('gpt-4o-mini');
    });

    it('should calculate token efficiency', async () => {
      await analytics.trackResponseExtended({
        agentId: 'agent-1',
        response: 'Response',
        responseLength: 8,
        timestamp: new Date(),
        timings: { total: 200 },
        tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        success: true,
      });

      const metrics = analytics.getCostMetrics();
      expect(metrics.tokenEfficiency).toBe(0.5); // 50/100
    });
  });

  describe('getConversationMetrics', () => {
    it('should track thread abandonment rate', async () => {
      // Thread 1: Only 1 message (abandoned)
      await analytics.trackRequestExtended({
        agentId: 'agent-1',
        threadId: 'thread-abandoned',
        message: 'Single message',
        messageLength: 14,
        timestamp: new Date(),
      });

      // Thread 2: Multiple messages (engaged)
      await analytics.trackRequestExtended({
        agentId: 'agent-1',
        threadId: 'thread-engaged',
        message: 'First message',
        messageLength: 13,
        timestamp: new Date(),
      });
      await analytics.trackRequestExtended({
        agentId: 'agent-1',
        threadId: 'thread-engaged',
        message: 'Second message',
        messageLength: 14,
        timestamp: new Date(),
      });

      const metrics = analytics.getConversationMetrics();
      expect(metrics.totalThreads).toBe(2);
      expect(metrics.threadAbandonmentRate).toBe(0.5);
    });

    it('should calculate input length distribution', async () => {
      await analytics.trackRequestExtended({
        agentId: 'agent-1',
        threadId: 'thread-1', // threadId required for conversation metrics
        message: 'Hi',
        messageLength: 2, // short
        timestamp: new Date(),
      });

      await analytics.trackRequestExtended({
        agentId: 'agent-1',
        threadId: 'thread-2',
        message: 'This is a medium length message that is around 100 characters',
        messageLength: 100, // medium
        timestamp: new Date(),
      });

      await analytics.trackRequestExtended({
        agentId: 'agent-1',
        threadId: 'thread-3',
        message: 'x'.repeat(300),
        messageLength: 300, // long
        timestamp: new Date(),
      });

      const metrics = analytics.getConversationMetrics();
      expect(metrics.inputLengthDistribution.short).toBe(1);
      expect(metrics.inputLengthDistribution.medium).toBe(1);
      expect(metrics.inputLengthDistribution.long).toBe(1);
    });
  });

  describe('getErrorMetrics', () => {
    it('should calculate error rate', async () => {
      // Track some responses
      for (let i = 0; i < 10; i++) {
        await analytics.trackResponseExtended({
          agentId: 'agent-1',
          response: 'Response',
          responseLength: 8,
          timestamp: new Date(),
          timings: { total: 200 },
          tokens: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
          success: true,
        });
      }

      // Track some errors
      await analytics.trackError({
        agentId: 'agent-1',
        timestamp: new Date(),
        errorType: 'timeout',
        errorMessage: 'Timed out',
        component: 'llm',
      });

      const metrics = analytics.getErrorMetrics();
      expect(metrics.errorRate).toBeCloseTo(0.1, 2); // 1/10
      expect(metrics.successRate).toBeCloseTo(0.9, 2);
    });
  });

  // ==========================================================================
  // Time Series Tests
  // ==========================================================================

  describe('getTimeSeries', () => {
    it('should group data by day', async () => {
      const day1 = new Date('2024-01-15T10:00:00Z');
      const day2 = new Date('2024-01-16T10:00:00Z');

      await analytics.trackResponseExtended({
        agentId: 'agent-1',
        response: 'Response',
        responseLength: 8,
        timestamp: day1,
        timings: { total: 100 },
        tokens: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
        success: true,
      });

      await analytics.trackResponseExtended({
        agentId: 'agent-1',
        response: 'Response',
        responseLength: 8,
        timestamp: day2,
        timings: { total: 200 },
        tokens: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
        success: true,
      });

      const series = analytics.getTimeSeries('latency', { groupBy: 'day' });
      expect(series.length).toBe(2);
    });

    it('should aggregate by metric type', async () => {
      await analytics.trackResponseExtended({
        agentId: 'agent-1',
        response: 'Response',
        responseLength: 8,
        timestamp: new Date(),
        timings: { total: 100 },
        tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        success: true,
      });

      const tokensSeries = analytics.getTimeSeries('tokens');
      expect(tokensSeries[0].value).toBe(150);

      const requestsSeries = analytics.getTimeSeries('requests');
      expect(requestsSeries[0].value).toBe(1);
    });
  });

  // ==========================================================================
  // Aggregated Metrics Tests
  // ==========================================================================

  describe('getMetrics', () => {
    it('should return all metric categories', async () => {
      await analytics.trackRequestExtended({
        agentId: 'agent-1',
        threadId: 'thread-1',
        message: 'Hello',
        messageLength: 5,
        timestamp: new Date(),
      });

      await analytics.trackResponseExtended({
        agentId: 'agent-1',
        threadId: 'thread-1',
        response: 'Hi there!',
        responseLength: 9,
        timestamp: new Date(),
        timings: { total: 250 },
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        success: true,
        model: 'gpt-4o',
      });

      const metrics = await analytics.getMetrics();
      expect(metrics.period).toBeDefined();
      expect(metrics.performance).toBeDefined();
      expect(metrics.rag).toBeDefined();
      expect(metrics.cost).toBeDefined();
      expect(metrics.conversation).toBeDefined();
      expect(metrics.errors).toBeDefined();
    });

    it('should filter by date range', async () => {
      const oldDate = new Date('2024-01-01');
      const newDate = new Date('2024-06-01');

      await analytics.trackResponseExtended({
        agentId: 'agent-1',
        response: 'Old',
        responseLength: 3,
        timestamp: oldDate,
        timings: { total: 100 },
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        success: true,
      });

      await analytics.trackResponseExtended({
        agentId: 'agent-1',
        response: 'New',
        responseLength: 3,
        timestamp: newDate,
        timings: { total: 200 },
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        success: true,
      });

      const metrics = await analytics.getMetrics({
        startDate: new Date('2024-05-01'),
        endDate: new Date('2024-07-01'),
      });

      expect(metrics.performance.totalRequests).toBe(1);
    });
  });

  // ==========================================================================
  // Event Callback Tests
  // ==========================================================================

  describe('onMetric callback', () => {
    it('should call onMetric for requests', async () => {
      const onMetric = vi.fn();
      const a = new SnapAgentAnalytics({ onMetric });

      await a.trackRequest({
        agentId: 'agent-1',
        message: 'Hello',
        timestamp: new Date(),
      });

      expect(onMetric).toHaveBeenCalledTimes(1);
      expect(onMetric).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'request',
        })
      );
    });

    it('should call onMetric for responses', async () => {
      const onMetric = vi.fn();
      const a = new SnapAgentAnalytics({ onMetric });

      await a.trackResponse({
        agentId: 'agent-1',
        response: 'Hello',
        latency: 100,
        timestamp: new Date(),
      });

      expect(onMetric).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
        })
      );
    });

    it('should call onMetric for errors', async () => {
      const onMetric = vi.fn();
      const a = new SnapAgentAnalytics({ onMetric });

      await a.trackError({
        agentId: 'agent-1',
        timestamp: new Date(),
        errorType: 'timeout',
        errorMessage: 'Timed out',
      });

      expect(onMetric).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
        })
      );
    });
  });

  // ==========================================================================
  // Utility Methods Tests
  // ==========================================================================

  describe('exportData', () => {
    it('should export all raw data', async () => {
      await analytics.trackRequest({
        agentId: 'agent-1',
        message: 'Hello',
        timestamp: new Date(),
      });

      await analytics.trackResponse({
        agentId: 'agent-1',
        response: 'Hi',
        latency: 100,
        timestamp: new Date(),
      });

      const data = analytics.exportData();
      expect(data.requests.length).toBe(1);
      expect(data.responses.length).toBe(1);
      expect(data.errors.length).toBe(0);
    });
  });

  describe('clear', () => {
    it('should clear all data', async () => {
      await analytics.trackRequest({
        agentId: 'agent-1',
        message: 'Hello',
        timestamp: new Date(),
      });

      analytics.clear();

      const summary = analytics.getSummary();
      expect(summary.totalRequests).toBe(0);
      expect(summary.totalResponses).toBe(0);
      expect(summary.totalErrors).toBe(0);
    });
  });

  describe('getSummary', () => {
    it('should return summary statistics', async () => {
      await analytics.trackRequest({
        agentId: 'agent-1',
        threadId: 'thread-1',
        message: 'Hello',
        timestamp: new Date(),
      });

      const summary = analytics.getSummary();
      expect(summary.totalRequests).toBe(1);
      expect(summary.totalThreads).toBe(1);
    });
  });

  // ==========================================================================
  // Flush Mechanism Tests
  // ==========================================================================

  describe('flush', () => {
    it('should flush pending data to storage', async () => {
      const storage = new MemoryAnalyticsStorage();
      const a = new SnapAgentAnalytics({ storage });

      await a.trackRequest({
        agentId: 'agent-1',
        message: 'Hello',
        timestamp: new Date(),
      });

      expect(a.getPendingCount().requests).toBe(1);

      await a.flush();

      expect(a.getPendingCount().requests).toBe(0);
      
      const stored = await storage.getRequests();
      expect(stored.length).toBe(1);
    });
  });

  describe('stop', () => {
    it('should stop and flush remaining data', async () => {
      const storage = new MemoryAnalyticsStorage();
      const a = new SnapAgentAnalytics({ storage, flushInterval: 60000 });

      await a.trackRequest({
        agentId: 'agent-1',
        message: 'Hello',
        timestamp: new Date(),
      });

      await a.stop();

      const stored = await storage.getRequests();
      expect(stored.length).toBe(1);
    });
  });

  describe('getPendingCount', () => {
    it('should return pending item counts', async () => {
      await analytics.trackRequest({
        agentId: 'agent-1',
        message: 'Hello',
        timestamp: new Date(),
      });

      await analytics.trackResponse({
        agentId: 'agent-1',
        response: 'Hi',
        latency: 100,
        timestamp: new Date(),
      });

      const pending = analytics.getPendingCount();
      expect(pending.requests).toBe(1);
      expect(pending.responses).toBe(1);
      expect(pending.errors).toBe(0);
    });
  });

  // ==========================================================================
  // Empty Metrics Tests
  // ==========================================================================

  describe('empty metrics', () => {
    it('should return empty performance metrics when no data', () => {
      const metrics = analytics.getPerformanceMetrics();
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.avgLatency).toBe(0);
    });

    it('should return empty RAG metrics when no data', () => {
      const metrics = analytics.getRAGMetrics();
      expect(metrics.totalQueries).toBe(0);
      expect(metrics.avgDocumentsRetrieved).toBe(0);
    });

    it('should return empty cost metrics when no data', () => {
      const metrics = analytics.getCostMetrics();
      expect(metrics.totalCost).toBe(0);
      expect(metrics.totalTokens).toBe(0);
    });

    it('should return empty conversation metrics when no data', () => {
      const metrics = analytics.getConversationMetrics();
      expect(metrics.totalThreads).toBe(0);
      expect(metrics.totalMessages).toBe(0);
    });

    it('should return empty error metrics when no data', () => {
      const metrics = analytics.getErrorMetrics();
      expect(metrics.totalErrors).toBe(0);
      expect(metrics.successRate).toBe(1);
    });
  });
});

