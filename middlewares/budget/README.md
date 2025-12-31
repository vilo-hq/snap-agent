# @snap-agent/middleware-budget

**Cost control middleware for SnapAgent SDK** — Set daily/monthly spending limits in dollars or tokens to prevent billing surprises.

## Goal

**Prevent runaway costs.** Budget middleware tracks cumulative token usage and costs over time (hours, days, months) and stops or downgrades requests before you exceed your spending limit.

| Budget | Rate Limit |
|--------|------------|
| Limits **spending** (tokens/cost) | Limits **frequency** (requests/second) |
| Resets daily/monthly | Resets every few seconds/minutes |
| Goal: **Cost control** | Goal: **Abuse prevention** |
| "$10/day per user" | "100 requests/minute per user" |

> 💡 Use **Budget** to control costs. Use **[Rate Limit](../ratelimit)** to prevent API hammering.

## Installation

```bash
npm install @snap-agent/middleware-budget
```

## Quick Start

```typescript
import { createClient } from '@snap-agent/core';
import { TokenBudget } from '@snap-agent/middleware-budget';

const budget = new TokenBudget({
  maxTokensPerRequest: 4000,
  maxTokensPerPeriod: 100000,
  maxCostPerPeriod: 10.00, // $10/day
  period: 'day',
  keyBy: 'userId',
  onExceed: 'fallback',
  fallbackModel: 'gpt-4o-mini',
});

const agent = await client.createAgent({
  plugins: [budget],
  // ...
});
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxTokensPerRequest` | `number` | unlimited | Max tokens per request |
| `maxTokensPerPeriod` | `number` | unlimited | Max tokens per period |
| `maxCostPerPeriod` | `number` | unlimited | Max cost (USD) per period |
| `period` | `string` | `'day'` | Budget period |
| `keyBy` | `string` | `'global'` | How to track budget |
| `onExceed` | `string` | `'reject'` | Action when exceeded |
| `fallbackModel` | `string` | - | Model when budget exceeded |
| `warningThreshold` | `number` | `0.8` | Warning at 80% usage |

## Budget Periods

- `hour` - Resets every hour
- `day` - Resets at midnight
- `week` - Resets on Sunday
- `month` - Resets on the 1st

## On Exceed Actions

- `reject` - Return error message
- `fallback` - Use cheaper model
- `warn` - Allow but log warning

## Examples

### Per-User Daily Budget

```typescript
new TokenBudget({
  maxTokensPerPeriod: 50000,
  maxCostPerPeriod: 5.00,
  period: 'day',
  keyBy: 'userId',
});
```

### Organization Budget with Fallback

```typescript
new TokenBudget({
  maxCostPerPeriod: 100.00,
  period: 'month',
  keyBy: 'organizationId',
  onExceed: 'fallback',
  fallbackModel: 'gpt-3.5-turbo',
  onWarning: (status) => {
    slack.send(`Warning: Budget 80% used: $${status.costUsed.toFixed(2)}/$${status.costLimit}`);
  },
});
```

### Request Size Limit

```typescript
new TokenBudget({
  maxTokensPerRequest: 4000, // Limit context window
});
```

### Custom Model Costs

```typescript
new TokenBudget({
  maxCostPerPeriod: 50.00,
  modelCosts: {
    'my-custom-model': { input: 0.01, output: 0.02 },
  },
});
```

### Persistent Budget (Redis)

```typescript
import { Redis } from 'ioredis';

const redis = new Redis();

new TokenBudget({
  maxCostPerPeriod: 100.00,
  storage: {
    async get(key) {
      const data = await redis.get(`budget:${key}`);
      return data ? JSON.parse(data) : null;
    },
    async set(key, entry) {
      const ttl = Math.max(0, entry.resetAt - Date.now());
      await redis.set(`budget:${key}`, JSON.stringify(entry), 'PX', ttl);
    },
  },
});
```

## Budget Status

Get current budget status:

```typescript
const status = await budget.getStatus('user:123');
console.log({
  tokensUsed: status.tokensUsed,
  tokensRemaining: status.tokensRemaining,
  costUsed: status.costUsed,
  percentUsed: status.percentUsed,
  resetAt: status.resetAt,
});
```

## License

MIT

