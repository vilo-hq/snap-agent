# Snap-Agent

**An extensible, lightweight AI Agent SDK that runs everywhere.**
Build stateful AI agents with multi-provider support. Extensible via plugins. Edge-runtime compatible.

[![npm version](https://img.shields.io/npm/v/@snap-agent/core.svg)](https://www.npmjs.com/package/@snap-agent/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why Snap-Agent?

| | Snap-Agent | OpenAI Agents SDK | LangChain |
|--|-----------|-------------------|-----------|
| **Edge Compatible** | ✅ | ❌ | ❌ |
| **Bundle Size** | ~63 KB | ~150 KB | ~2 MB+ |
| **Multi-Provider** | ✅ OpenAI, Anthropic, Google | ❌ OpenAI only | ✅ |
| **Plugin Architecture** | ✅ RAG, Tools, Middleware | ⚠️ Tools only | ✅ Chains |
| **Persistent Storage** | ✅ Upstash, MongoDB | ❌ In-memory only | ⚠️ Via integrations |
| **Zero-Config RAG** | ✅ Built-in | ❌ | ❌ |

## Quick Start

```bash
npm install @snap-agent/core ai @ai-sdk/openai
```

```typescript
import { createClient, MemoryStorage } from '@snap-agent/core';

const client = createClient({
  storage: new MemoryStorage(),
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
  },
});

const agent = await client.createAgent({
  name: 'My Assistant',
  instructions: 'You are helpful.',
  provider: 'openai',
  model: 'gpt-4o-mini',
  userId: 'user-123',
});

const thread = await agent.createThread();
const { reply } = await thread.chat('Hello!');

console.log(reply);
```

## Packages

This is a monorepo containing the core SDK and official plugins.

### Core SDK

| Package | Description | Docs |
|---------|-------------|------|
| [`@snap-agent/core`](./sdk) | Core SDK with multi-provider support, storage adapters, and plugin system | [README](./sdk/README.md) |

### RAG Plugins

| Package | Description |
|---------|-------------|
| [`@snap-agent/rag-ecommerce`](./plugins/rag-ecommerce) | E-commerce product search with attribute extraction and caching |
| [`@snap-agent/rag-docs`](./plugins/rag/docs) | Documentation search |
| [`@snap-agent/rag-support`](./plugins/rag/support) | Support ticket search |

### Middleware Plugins

| Package | Description |
|---------|-------------|
| [`@snap-agent/middleware-ratelimit`](./middlewares/ratelimit) | Request rate limiting |
| [`@snap-agent/middleware-moderation`](./middlewares/moderation) | Content moderation |
| [`@snap-agent/middleware-budget`](./middlewares/budget) | Token budget management |
| [`@snap-agent/middleware-slack`](./middlewares/slack) | Slack notifications |
| [`@snap-agent/middleware-discord`](./middlewares/discord) | Discord notifications |
| [`@snap-agent/middleware-webhooks`](./middlewares/webhooks) | Custom webhook notifications |

### Analytics Plugins

| Package | Description |
|---------|-------------|
| [`@snap-agent/analytics-core`](./plugins/analytics/core) | Analytics base implementation |
| [`@snap-agent/analytics-console`](./plugins/analytics/console) | Console logging analytics |

## Features

- **Multi-Provider** — Switch between OpenAI, Anthropic, and Google seamlessly
- **Edge Runtime** — Deploy to Cloudflare Workers, Vercel Edge, Deno Deploy
- **Plugin Architecture** — Extend with RAG, tools, middleware, and analytics
- **Persistent Storage** — Upstash Redis (edge), MongoDB (server), or custom
- **Zero-Config RAG** — Semantic search with one line of config
- **Stateful Threads** — Automatic conversation history management
- **TypeScript First** — Full type safety and excellent IDE support
- **Streaming** — Real-time response streaming built-in

## Documentation

- [**SDK Documentation**](./sdk/README.md) — Full API reference and examples
- [**Edge Runtime Guide**](./sdk/docs/EDGE_RUNTIME.md) — Deploy to edge runtimes
- [**Plugin Reference**](./sdk/docs/QUICK_REFERENCE_PLUGINS.md) — Plugin development guide

## Examples

```bash
cd sdk/examples

# Basic usage
npx ts-node basic.ts

# Multi-provider
npx ts-node multi-provider.ts

# Streaming
npx ts-node streaming.ts

# Edge deployment
npx ts-node edge-cloudflare-worker.ts
```

## Development

```bash
# Install dependencies
pnpm install

# Build SDK
cd sdk && pnpm build

# Run tests
pnpm test

# Run integration tests (requires API keys)
pnpm test:integration
```

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT © [ViloTech](https://github.com/vilo-hq)

## Links

- [npm](https://www.npmjs.com/package/@snap-agent/core)
- [GitHub Issues](https://github.com/vilo-hq/snap-agent/issues)
- [Documentation](./sdk/README.md)

