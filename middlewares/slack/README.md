# @snap-agent/middleware-slack

Slack notifications middleware for SnapAgent SDK. Send alerts and notifications to Slack channels based on configurable triggers.

## Installation

```bash
npm install @snap-agent/middleware-slack
# or
pnpm add @snap-agent/middleware-slack
```

## Quick Start

```typescript
import { createClient } from '@snap-agent/core';
import { SlackNotifications } from '@snap-agent/middleware-slack';

const slack = new SlackNotifications({
  webhookUrl: process.env.SLACK_WEBHOOK_URL!,
  triggers: {
    onError: true,
    onKeywords: ['urgent', 'help', 'escalate'],
    onLongResponse: 5000, // Notify if response > 5 seconds
  },
  mentionOnError: '@oncall',
  includeContext: true,
});

const client = createClient({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  // ...
});

const agent = await client.createAgent({
  name: 'Support Agent',
  plugins: [
    // ─── Middlewares (request/response interception) ───
    slack,
    
    // ─── Plugins (agent capabilities) ───
    // yourRAGPlugin,
  ],
});
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `webhookUrl` | `string` | *required* | Slack webhook URL |
| `triggers.onError` | `boolean` | `true` | Notify on errors |
| `triggers.onKeywords` | `string[]` | `[]` | Keywords to trigger notifications |
| `triggers.onLongResponse` | `number` | - | Latency threshold (ms) |
| `triggers.onEveryN` | `number` | - | Notify every N requests |
| `triggers.custom` | `function` | - | Custom trigger function |
| `channel` | `string` | - | Override webhook channel |
| `username` | `string` | `'SnapAgent'` | Bot username |
| `iconEmoji` | `string` | `':robot_face:'` | Bot emoji |
| `mentionOnError` | `string` | - | User/group to mention |
| `includeContext` | `boolean` | `false` | Include conversation in notifications |
| `maxMessageLength` | `number` | `500` | Truncate long messages |
| `formatMessage` | `function` | - | Custom message formatter |

## Trigger Examples

### Notify on Keywords

```typescript
new SlackNotifications({
  webhookUrl: '...',
  triggers: {
    onKeywords: ['refund', 'cancel', 'complaint'],
  },
});
```

### Custom Trigger

```typescript
new SlackNotifications({
  webhookUrl: '...',
  triggers: {
    custom: ({ input, output, latency }) => {
      // Notify if user mentions a competitor
      return input?.toLowerCase().includes('competitor');
    },
  },
});
```

### Custom Message Format

```typescript
new SlackNotifications({
  webhookUrl: '...',
  formatMessage: ({ type, agentId, input, output, error }) => {
    if (type === 'error') {
      return {
        text: `Error in ${agentId}: ${error?.message}`,
      };
    }
    return {
      text: `${agentId} responded`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Response:* ${output}` },
        },
      ],
    };
  },
});
```

## Getting a Webhook URL

1. Go to [Slack API](https://api.slack.com/messaging/webhooks)
2. Create a new app or use existing
3. Enable "Incoming Webhooks"
4. Create a webhook for your channel
5. Copy the webhook URL

## License

MIT

