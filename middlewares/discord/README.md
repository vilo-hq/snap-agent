# @snap-agent/middleware-discord

Discord notifications middleware for SnapAgent SDK. Send alerts and notifications to Discord channels.

## Installation

```bash
npm install @snap-agent/middleware-discord
```

## Quick Start

```typescript
import { createClient } from '@snap-agent/core';
import { DiscordNotifications } from '@snap-agent/middleware-discord';

const discord = new DiscordNotifications({
  webhookUrl: process.env.DISCORD_WEBHOOK_URL!,
  triggers: {
    onError: true,
    onKeywords: ['urgent', 'help'],
    onLongResponse: 5000,
  },
});

const agent = await client.createAgent({
  name: 'My Agent',
  plugins: [
    // ─── Middlewares (request/response interception) ───
    discord,
    
    // ─── Plugins (agent capabilities) ───
    // yourRAGPlugin,
  ],
});
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `webhookUrl` | `string` | *required* | Discord webhook URL |
| `triggers.onError` | `boolean` | `true` | Notify on errors |
| `triggers.onKeywords` | `string[]` | `[]` | Keywords to trigger |
| `triggers.onLongResponse` | `number` | - | Latency threshold (ms) |
| `username` | `string` | `'SnapAgent'` | Bot username |
| `avatarUrl` | `string` | - | Bot avatar URL |
| `mentionOnError` | `string` | - | Role/user to mention |
| `includeContext` | `boolean` | `false` | Include conversation |

## Getting a Webhook URL

1. Open Discord Server Settings
2. Go to Integrations > Webhooks
3. Create New Webhook
4. Copy the webhook URL

## License

MIT

