# @snap-agent/analytics

Comprehensive analytics plugin for SnapAgent SDK - Track performance, RAG, cost, conversation, and error metrics.

## Features

**5 Metric Categories:**
1. **Performance** - Latency, timing breakdown, percentiles (P50, P95, P99)
2. **RAG** - Retrieval stats, cache rates, similarity scores
3. **Cost & Tokens** - Usage tracking, cost calculation by model
4. **Conversation** - Engagement, session quality, abandonment
5. **Errors** - Error rates, component breakdown, reliability

- **Real-time Tracking** - Event callbacks for live dashboards
- **Time Series** - Historical data with grouping (hour/day/week)
- **Cost Calculation** - Pre-configured pricing for major models
- **Auto-Cleanup** - Configurable data retention  

## Installation

```bash
npm install @snap-agent/analytics @snap-agent/core
```

## Quick Start

```typescript
import { createClient, MemoryStorage } from '@snap-agent/core';
import { SnapAgentAnalytics } from '@snap-agent/analytics';

const analytics = new SnapAgentAnalytics({
  // All categories enabled by default
  enablePerformance: true,
  enableRAG: true,
  enableCost: true,
  enableConversation: true,
  enableErrors: true,
  
  // Real-time event handler
  onMetric: (event) => {
    console.log(`[${event.type}]`, event.data);
  },
});

const client = createClient({
  storage: new MemoryStorage(),
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
  },
});

const agent = await client.createAgent({
  name: 'Analytics Demo',
  instructions: 'You are helpful.',
  model: 'gpt-4o',
  userId: 'user-123',
  plugins: [analytics],
});

// Use the agent normally...
// Analytics are collected automatically

// Get metrics
const metrics = await analytics.getMetrics({
  agentId: agent.id,
  startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
});

console.log('Performance:', metrics.performance);
console.log('RAG:', metrics.rag);
console.log('Cost:', metrics.cost);
console.log('Conversation:', metrics.conversation);
console.log('Errors:', metrics.errors);
```

## Configuration

```typescript
const analytics = new SnapAgentAnalytics({
  // Enable/disable categories
  enablePerformance: true,
  enableRAG: true,
  enableCost: true,
  enableConversation: true,
  enableErrors: true,

  // Custom model costs (per 1K tokens)
  modelCosts: {
    'my-custom-model': { input: 0.001, output: 0.002 },
  },

  // Embedding cost (per 1K tokens)
  embeddingCost: 0.0001,

  // Data retention (days, 0 = forever)
  retentionDays: 30,

  // Real-time callback
  onMetric: (event) => {
    // Send to your monitoring system
    sendToDataDog(event);
  },
});
```

## Metric Categories

### 1. Performance Metrics

```typescript
const perf = analytics.getPerformanceMetrics({ agentId: 'agent-123' });

// Returns:
{
  totalRequests: 1500,
  avgLatency: 450,        // ms
  p50Latency: 380,
  p95Latency: 850,
  p99Latency: 1200,
  minLatency: 120,
  maxLatency: 5000,
  
  // Component breakdown
  avgLLMTime: 350,
  avgRAGTime: 80,
  avgPluginTime: 15,
  avgDbTime: 5,
  
  // Streaming
  avgTimeToFirstToken: 150,
  avgTimeToLastToken: 420,
  
  // Distribution
  latencyDistribution: {
    under100ms: 50,
    under500ms: 1200,
    under1s: 200,
    under5s: 45,
    over5s: 5
  }
}
```

### 2. RAG Metrics

```typescript
const rag = analytics.getRAGMetrics({ agentId: 'agent-123' });

// Returns:
{
  totalQueries: 800,
  avgDocumentsRetrieved: 4.2,
  avgVectorSearchTime: 45,     // ms
  avgEmbeddingTime: 30,
  cacheHitRate: 0.72,          // 72%
  cacheMissRate: 0.28,
  avgSimilarityScore: 0.85,
  avgRerankTime: 25,
  avgContextLength: 2500,      // chars
  avgContextTokens: 650,
  avgSourcesCount: 3.8,
  retrievalSuccessRate: 0.95   // 95%
}
```

### 3. Cost & Token Metrics

```typescript
const cost = analytics.getCostMetrics({ agentId: 'agent-123' });

// Returns:
{
  totalCost: 45.67,            // USD
  totalTokens: 2500000,
  totalPromptTokens: 1800000,
  totalCompletionTokens: 700000,
  avgTokensPerRequest: 1667,
  avgCostPerRequest: 0.03,
  tokenEfficiency: 0.39,       // output/input ratio
  
  // Breakdowns
  costByModel: {
    'gpt-4o': 35.50,
    'gpt-4o-mini': 10.17
  },
  costByAgent: {
    'agent-123': 45.67
  },
  tokensByModel: {
    'gpt-4o': 1800000,
    'gpt-4o-mini': 700000
  },
  
  // Embeddings
  totalEmbeddingTokens: 500000,
  totalEmbeddingCost: 0.05,
  
  // Time-based
  dailyCosts: {
    '2024-01-15': 5.20,
    '2024-01-16': 6.10,
    // ...
  }
}
```

### 4. Conversation Metrics

```typescript
const conv = analytics.getConversationMetrics({ agentId: 'agent-123' });

// Returns:
{
  totalThreads: 450,
  totalMessages: 3200,
  avgMessagesPerThread: 7.1,
  avgThreadDuration: 180000,   // ms (~3 min)
  avgSessionLength: 180000,
  userReturnRate: 0.65,        // 65% of users come back
  threadAbandonmentRate: 0.12, // 12% abandon after 1 message
  
  // Message characteristics
  avgInputLength: 125,         // chars
  avgOutputLength: 450,
  inputLengthDistribution: {
    short: 800,     // < 50 chars
    medium: 1500,   // 50-200 chars
    long: 700,      // 200-500 chars
    veryLong: 200   // > 500 chars
  }
}
```

### 5. Error Metrics

```typescript
const errors = analytics.getErrorMetrics({ agentId: 'agent-123' });

// Returns:
{
  totalErrors: 45,
  errorRate: 0.03,             // 3%
  
  // By type
  errorsByType: {
    'rate_limit': 20,
    'timeout': 15,
    'api_error': 10
  },
  
  // By component
  llmErrors: 30,
  ragErrors: 5,
  pluginErrors: 5,
  dbErrors: 3,
  networkErrors: 2,
  timeoutErrors: 15,
  rateLimitHits: 20,
  
  // Reliability
  successRate: 0.97,
  retryCount: 50,
  fallbackUsage: 5,
  
  // Recent errors
  recentErrors: [
    { timestamp: Date, type: 'rate_limit', message: '...', agentId: '...' },
    // ...
  ]
}
```

## Time Series Data

```typescript
// Get latency over time
const latencySeries = analytics.getTimeSeries('latency', {
  agentId: 'agent-123',
  startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  groupBy: 'day',
});

// Returns:
[
  { timestamp: Date, value: 450, metadata: { count: 200 } },
  { timestamp: Date, value: 420, metadata: { count: 185 } },
  // ...
]

// Available metrics: 'latency' | 'tokens' | 'cost' | 'errors' | 'requests'
```

## Extended Tracking

For detailed metrics, use the extended tracking methods:

```typescript
// Track request with full context
await analytics.trackRequestExtended({
  agentId: 'agent-123',
  threadId: 'thread-456',
  userId: 'user-789',
  organizationId: 'org-abc',
  message: 'User message',
  messageLength: 50,
  timestamp: new Date(),
  model: 'gpt-4o',
  provider: 'openai',
});

// Track response with all metrics
await analytics.trackResponseExtended({
  agentId: 'agent-123',
  threadId: 'thread-456',
  userId: 'user-789',
  response: 'Assistant response',
  responseLength: 200,
  timestamp: new Date(),
  
  // Performance timings
  timings: {
    total: 450,
    llmApiTime: 350,
    ragRetrievalTime: 80,
    pluginExecutionTime: 15,
    dbQueryTime: 5,
    timeToFirstToken: 150,
    timeToLastToken: 420,
  },
  
  // Token usage
  tokens: {
    promptTokens: 500,
    completionTokens: 150,
    totalTokens: 650,
  },
  
  // RAG metrics (if enabled)
  rag: {
    enabled: true,
    documentsRetrieved: 5,
    vectorSearchTime: 45,
    embeddingTime: 30,
    cacheHit: true,
    avgSimilarityScore: 0.85,
    contextLength: 2500,
    contextTokens: 600,
    sourcesCount: 4,
  },
  
  // Status
  success: true,
  model: 'gpt-4o',
  provider: 'openai',
});

// Track errors
await analytics.trackError({
  agentId: 'agent-123',
  threadId: 'thread-456',
  timestamp: new Date(),
  errorType: 'rate_limit',
  errorMessage: 'Rate limit exceeded',
  component: 'llm',
});
```

## Pre-configured Model Costs

The plugin comes with pre-configured costs for major models:

| Model | Input (per 1K) | Output (per 1K) |
|-------|----------------|-----------------|
| gpt-4o | $0.005 | $0.015 |
| gpt-4o-mini | $0.00015 | $0.0006 |
| gpt-4-turbo | $0.01 | $0.03 |
| gpt-4 | $0.03 | $0.06 |
| gpt-3.5-turbo | $0.0005 | $0.0015 |
| claude-3-5-sonnet | $0.003 | $0.015 |
| claude-3-opus | $0.015 | $0.075 |
| claude-3-haiku | $0.00025 | $0.00125 |
| gemini-1.5-pro | $0.00125 | $0.005 |
| gemini-1.5-flash | $0.000075 | $0.0003 |

Add custom models via config:
```typescript
new SnapAgentAnalytics({
  modelCosts: {
    'my-custom-model': { input: 0.001, output: 0.002 },
  },
});
```

## Export & Utility

```typescript
// Get raw data for export
const data = analytics.exportData();
// { requests: [...], responses: [...], errors: [...] }

// Get summary
const summary = analytics.getSummary();
// { totalRequests: 1500, totalErrors: 45, ... }

// Clear all data
analytics.clear();
```

## Integration Examples

### Send to DataDog

```typescript
import { datadogLogs } from '@datadog/browser-logs';

new SnapAgentAnalytics({
  onMetric: (event) => {
    datadogLogs.logger.info('snap-agent.metric', {
      type: event.type,
      ...event.data,
    });
  },
});
```

### Send to PostHog

```typescript
import posthog from 'posthog-js';

new SnapAgentAnalytics({
  onMetric: (event) => {
    posthog.capture(`snapagent_${event.type}`, event.data);
  },
});
```

### Custom Dashboard

```typescript
import express from 'express';

const app = express();
const analytics = new SnapAgentAnalytics();

app.get('/metrics', async (req, res) => {
  const metrics = await analytics.getMetrics({
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });
  res.json(metrics);
});

app.get('/metrics/timeseries/:metric', (req, res) => {
  const series = analytics.getTimeSeries(
    req.params.metric as any,
    { groupBy: 'hour' }
  );
  res.json(series);
});
```

## License

MIT © ViloTech

