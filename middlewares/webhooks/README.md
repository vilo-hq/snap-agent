# @snap-agent/middleware-webhooks

Generic webhooks middleware for SnapAgent SDK. Send agent events to any HTTP endpoint.

## Installation

```bash
npm install @snap-agent/middleware-webhooks
```

## Quick Start

```typescript
import { createClient } from '@snap-agent/core';
import { WebhookNotifier } from '@snap-agent/middleware-webhooks';

const webhook = new WebhookNotifier({
  url: 'https://your-api.com/agent-events',
  events: ['response', 'error'],
  headers: {
    'Authorization': 'Bearer your-token',
  },
});

const agent = await client.createAgent({
  plugins: [webhook],
  // ...
});
```

## Webhook Payload

```json
{
  "event": "response",
  "timestamp": "2024-01-15T12:00:00.000Z",
  "agentId": "agent-123",
  "threadId": "thread-456",
  "data": {
    "input": "User message",
    "output": "Agent response",
    "latency": 1234,
    "error": null
  },
  "metadata": {}
}
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | *required* | Webhook URL |
| `events` | `string[]` | `['response', 'error']` | Events to send |
| `headers` | `object` | `{}` | HTTP headers |
| `method` | `string` | `'POST'` | HTTP method |
| `timeout` | `number` | `5000` | Timeout (ms) |
| `retries` | `number` | `2` | Retry count |
| `retryDelay` | `number` | `1000` | Retry delay (ms) |
| `includeContent` | `boolean` | `true` | Include messages |
| `async` | `boolean` | `true` | Non-blocking |

## Custom Payload Transform

```typescript
new WebhookNotifier({
  url: '...',
  transformPayload: (payload) => ({
    type: payload.event,
    agent: payload.agentId,
    message: payload.data.output,
  }),
});
```

## Filter Events

```typescript
new WebhookNotifier({
  url: '...',
  filter: (payload) => {
    // Only send if latency > 2 seconds
    return (payload.data.latency || 0) > 2000;
  },
});
```

## License

MIT

