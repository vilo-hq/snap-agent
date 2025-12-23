# @snap-agent/middleware-ratelimit

Rate limiting middleware for SnapAgent SDK. Per-user, per-agent, or global rate limiting to prevent abuse and control costs.

## Installation

```bash
npm install @snap-agent/middleware-ratelimit
```

## Quick Start

```typescript
import { createClient } from '@snap-agent/core';
import { RateLimiter } from '@snap-agent/middleware-ratelimit';

const rateLimiter = new RateLimiter({
  maxRequests: 100,
  windowMs: 60 * 1000, // 1 minute
  keyBy: 'userId',
  onLimit: 'reject',
});

const agent = await client.createAgent({
  plugins: [rateLimiter],
  // ...
});
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxRequests` | `number` | `100` | Max requests per window |
| `windowMs` | `number` | `60000` | Window size in ms |
| `keyBy` | `string` | `'userId'` | How to bucket limits |
| `onLimit` | `string` | `'reject'` | Action when limited |
| `limitMessage` | `string` | "Too many requests..." | Message when limited |

## Key By Options

- `userId` - Rate limit per user
- `threadId` - Rate limit per thread
- `agentId` - Rate limit per agent
- `ip` - Rate limit per IP
- `global` - Global rate limit
- Custom function for advanced use cases

## On Limit Actions

- `reject` - Return error message immediately
- `queue` - Queue request until rate limit resets
- `throttle` - Allow but add delay

## Examples

### Per-User Rate Limiting

```typescript
new RateLimiter({
  maxRequests: 50,
  windowMs: 60000,
  keyBy: 'userId',
});
```

### Custom Key Function

```typescript
new RateLimiter({
  maxRequests: 100,
  windowMs: 60000,
  keyBy: (context) => {
    // Rate limit by organization
    return `org:${context.metadata?.organizationId || 'unknown'}`;
  },
});
```

### Skip Certain Users

```typescript
new RateLimiter({
  maxRequests: 100,
  windowMs: 60000,
  skip: (key, context) => {
    // Skip rate limiting for admin users
    return context.metadata?.role === 'admin';
  },
});
```

### Queue Mode

```typescript
new RateLimiter({
  maxRequests: 10,
  windowMs: 60000,
  onLimit: 'queue',
  queue: {
    maxSize: 100,
    timeout: 30000, // 30 second timeout
  },
});
```

### Distributed Rate Limiting (Redis)

```typescript
import { Redis } from 'ioredis';

const redis = new Redis();

new RateLimiter({
  maxRequests: 100,
  windowMs: 60000,
  storage: {
    async get(key) {
      const data = await redis.get(`ratelimit:${key}`);
      return data ? JSON.parse(data) : null;
    },
    async set(key, entry, ttlMs) {
      await redis.set(`ratelimit:${key}`, JSON.stringify(entry), 'PX', ttlMs);
    },
    async increment(key, windowMs) {
      const now = Date.now();
      const multi = redis.multi();
      multi.incr(`ratelimit:${key}:count`);
      multi.pexpire(`ratelimit:${key}:count`, windowMs);
      const [[, count]] = await multi.exec();
      return {
        count: count as number,
        resetAt: now + windowMs,
      };
    },
  },
});
```

## Rate Limit Headers

When `includeHeaders: true` (default), rate limit info is added to response metadata:

```typescript
// Available in response metadata
{
  headers: {
    'X-RateLimit-Limit': 100,
    'X-RateLimit-Remaining': 95,
    'X-RateLimit-Reset': '2024-01-15T12:01:00.000Z'
  }
}
```

## License

MIT

