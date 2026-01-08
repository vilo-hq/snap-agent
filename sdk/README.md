# SnapAgent

**The AI Agent SDK that runs everywhere.** A TypeScript-first SDK for building stateful AI agents with multi-provider support. Extensible via plugins. Edge-runtime compatible.

## Why SnapAgent?

| | SnapAgent | OpenAI Agents SDK | LangChain |
|--|-----------|-------------------|-----------|
| **Edge Compatible** | ✅ | ❌ | ❌ |
| **Bundle Size** | ~63 KB | ~150 KB | ~2 MB+ |
| **Multi-Provider** | OpenAI, Anthropic, Google | OpenAI only | ✅ |
| **Plugin Architecture** | RAG, Tools, Middleware, Analytics | Tools only | Chains |
| **Plugin Persistence** | ✅ Registry pattern | ❌ | ❌ |
| **Persistent Storage** | Upstash, MongoDB, Memory | In-memory only | Via integrations |
| **Zero-Config RAG** | Built-in | Manual | Manual |

## Features

- **Multi-Provider** — Switch between OpenAI, Anthropic, and Google seamlessly  
- **Edge Runtime** — Deploy to Cloudflare Workers, Vercel Edge, Deno Deploy  
- **Plugin Architecture** — Extend with RAG, tools, middleware, and analytics plugins  
- **Plugin Persistence** — Plugins survive server restarts via the Plugin Registry  
- **Persistent Storage** — Upstash Redis (edge), MongoDB (server), or bring your own  
- **Zero-Config RAG** — Add semantic search with one line of config  
- **Stateful Threads** — Automatic conversation history management  
- **TypeScript First** — Full type safety and excellent IDE support  
- **Streaming** — Real-time response streaming built-in

## Installation

```bash
npm install @snap-agent/core ai @ai-sdk/openai

# Optional: Additional providers
npm install @ai-sdk/anthropic @ai-sdk/google

# Optional: Persistent storage
npm install mongodb          # For server environments
# Upstash works out of the box (REST API, no package needed)
```

## Quick Start

```typescript
import { createClient, MongoDBStorage } from '@snap-agent/core';

// Initialize the SDK
const client = createClient({
  storage: new MongoDBStorage('mongodb://localhost:27017/agents'),
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
    google: { apiKey: process.env.GOOGLE_API_KEY! },
  },
});

// Create an agent
const agent = await client.createAgent({
  name: 'Customer Support Bot',
  instructions: 'You are a helpful customer support agent.',
  model: 'gpt-4o',
  userId: 'user-123',
  provider: 'openai', // or 'anthropic', 'google'
});

// Create a conversation thread
const thread = await client.createThread({
  agentId: agent.id,
  userId: 'user-123',
  name: 'Support Conversation',
});

// Chat!
const response = await client.chat({
  threadId: thread.id,
  message: 'Hello! I need help with my account.',
});

console.log(response.reply);
```

## Core Concepts

### Agents

Agents are AI assistants with specific instructions, using a specific LLM provider and model. 
Snap Agents are extendable via plugins and support middlewares to intercept requests or enriching responses 

```typescript
// Create an agent
const agent = await client.createAgent({
  name: 'Code Reviewer',
  instructions: 'You are an expert code reviewer. Provide constructive feedback.',
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  userId: 'user-123',
});

// Update agent
await agent.update({
  instructions: 'You are a senior code reviewer with 10 years of experience.',
});

// List all agents for a user
const agents = await client.listAgents('user-123');

// Delete agent
await client.deleteAgent(agent.id);
```

### Threads

Threads represent conversation sessions with persistent message history.

```typescript
// Create a thread
const thread = await client.createThread({
  agentId: agent.id,
  userId: 'user-123',
  name: 'Code Review Session',
});

// Get thread
const loadedThread = await client.getThread(thread.id);

// List threads for an agent
const threads = await client.listThreads({ agentId: agent.id });

// Delete thread
await client.deleteThread(thread.id);
```

### Messages & Chat

Send messages and get AI responses with automatic history management.

```typescript
// Simple chat
const response = await client.chat({
  threadId: thread.id,
  message: 'Review this code: const x = 1;',
});

// Streaming chat
await client.chatStream(
  {
    threadId: thread.id,
    message: 'Tell me a story',
  },
  {
    onChunk: (chunk) => process.stdout.write(chunk),
    onComplete: (fullResponse) => console.log('\nDone'),
    onError: (error) => console.error('Error:', error),
  }
);
```

## Multi-Provider Support

Switch between OpenAI, Anthropic, and Google models easily:

```typescript
import { Models } from '@snap-agent/core';

// OpenAI
const gptAgent = await client.createAgent({
  name: 'GPT Agent',
  provider: 'openai',
  model: Models.OpenAI.GPT4O,
  instructions: 'You are helpful.',
  userId: 'user-123',
});

// Anthropic (Claude)
const claudeAgent = await client.createAgent({
  name: 'Claude Agent',
  provider: 'anthropic',
  model: Models.Anthropic.CLAUDE_35_SONNET,
  instructions: 'You are helpful.',
  userId: 'user-123',
});

// Google (Gemini)
const geminiAgent = await client.createAgent({
  name: 'Gemini Agent',
  provider: 'google',
  model: Models.Google.GEMINI_2_FLASH,
  instructions: 'You are helpful.',
  userId: 'user-123',
});
```

## Plugin Architecture

SnapAgent is built around a powerful plugin system. Extend your agents with any combination of plugins:

### Plugin Types

| Type | Purpose | Example Use Cases |
|------|---------|-------------------|
| **RAG Plugins** | Semantic search & document retrieval | Knowledge bases, product catalogs, support docs |
| **Tool Plugins** | Give agents executable capabilities | API calls, calculations, data lookups |
| **Middleware Plugins** | Intercept and transform requests/responses | Rate limiting, content moderation, logging |
| **Analytics Plugins** | Track usage and performance | Monitoring, billing, optimization |

### Understanding Plugin Types

All extensions are added to the `plugins` array, but they serve different purposes:

```
┌─────────────────────────────────────────────────────────────────┐
│                         plugins: [...]                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  MIDDLEWARES (run first, intercept requests)                   │
│  ├── RateLimiter      → Abuse prevention (100 req/min)         │
│  ├── TokenBudget      → Cost control ($10/day)                 │
│  ├── ContentModeration → Block harmful content                 │
│  └── SlackNotifications → Alert on errors                      │
│                                                                 │
│  PLUGINS (enhance agent capabilities)                          │
│  ├── EcommerceRAGPlugin → Product search knowledge             │
│  ├── DocsRAGPlugin      → Documentation knowledge              │
│  └── CustomTools        → Callable functions                   │
│                                                                 │
│  ANALYTICS (run last, track everything)                        │
│  ├── SnapAgentAnalytics → Full metrics suite                   │
│  └── ConsoleAnalytics   → Dev-friendly logging                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Execution order is handled automatically** via the `priority` field:
- Middlewares: priority 1-100 (run first)
- RAG/Tools: priority 100-150
- Analytics: priority 200+ (run last)

### Combining Plugins and Middlewares

```typescript
import { createClient, MemoryStorage } from '@snap-agent/core';
import { EcommerceRAGPlugin } from '@snap-agent/rag-ecommerce';
import { RateLimiter } from '@snap-agent/middleware-ratelimit';
import { TokenBudget } from '@snap-agent/middleware-budget';
import { SlackNotifications } from '@snap-agent/middleware-slack';
import { ConsoleAnalytics } from '@snap-agent/analytics-console';

const agent = await client.createAgent({
  name: 'Production Agent',
  instructions: 'You are a helpful shopping assistant.',
  provider: 'openai',
  model: 'gpt-4o',
  userId: 'user-123',
  plugins: [
    // ─────────────────────────────────────────────────────────────
    // MIDDLEWARES: Request/response interception (run first)
    // ─────────────────────────────────────────────────────────────
    new RateLimiter({                    // Abuse prevention
      maxRequests: 100,
      windowMs: 60000,
    }),
    new TokenBudget({                    // Cost control
      maxCostPerPeriod: 10.00,
      period: 'day',
    }),
    new SlackNotifications({             // Error alerts
      webhookUrl: process.env.SLACK_WEBHOOK!,
      triggers: { onError: true },
    }),

    // ─────────────────────────────────────────────────────────────
    // PLUGINS: Agent capabilities (RAG, tools)
    // ─────────────────────────────────────────────────────────────
    new EcommerceRAGPlugin({             // Product knowledge
      mongoUri: process.env.MONGODB_URI!,
      openaiApiKey: process.env.OPENAI_API_KEY!,
      tenantId: 'my-store',
    }),

    // ─────────────────────────────────────────────────────────────
    // ANALYTICS: Tracking and monitoring (run last)
    // ─────────────────────────────────────────────────────────────
    new ConsoleAnalytics({ level: 'standard' }),
  ],
});
```

### Building Custom Plugins

```typescript
import { MiddlewarePlugin, AnalyticsPlugin } from '@snap-agent/core';

// Custom middleware
class LoggingMiddleware implements MiddlewarePlugin {
  type = 'middleware' as const;
  name = 'logging';

  async beforeRequest(context: any) {
    console.log('Request:', context.message);
    return context;
  }

  async afterResponse(context: any, response: any) {
    console.log('Response:', response.reply.substring(0, 100));
    return response;
  }
}

// Custom analytics
class CustomAnalytics implements AnalyticsPlugin {
  type = 'analytics' as const;
  name = 'custom-analytics';

  async trackRequest(data: RequestTrackingData) {
    await myAnalyticsService.track('agent_request', data);
  }

  async trackResponse(data: ResponseTrackingData) {
    await myAnalyticsService.track('agent_response', data);
  }
}
```

### Plugin Persistence with Plugin Registry

Plugins are runtime objects (classes with methods, database connections, etc.) that can't be directly saved to a database. The **Plugin Registry** solves this by:

1. Storing serializable plugin configurations in your database
2. Automatically reinstantiating plugins when you load an agent after a process restart

#### Why Plugin Persistence Matters

Without the Plugin Registry, you'd lose all plugins when:
- Your server restarts
- A request is routed to a different server instance
- You load an agent from the database in a new process

#### Setting Up the Plugin Registry

```typescript
import { 
  createClient, 
  PluginRegistry, 
  MongoDBStorage 
} from '@snap-agent/core';
import { EcommerceRAGPlugin } from '@snap-agent/rag-ecommerce';
import { RateLimiter } from '@snap-agent/middleware-ratelimit';

// 1. Create and configure the registry
const registry = new PluginRegistry();

// 2. Register plugin factories (plugin name → factory function)
registry.register('@snap-agent/rag-ecommerce', (config) => 
  new EcommerceRAGPlugin(config)
);

registry.register('@snap-agent/middleware-ratelimit', (config) => 
  new RateLimiter(config)
);

// 3. Create client with registry
const client = createClient({
  storage: new MongoDBStorage(process.env.MONGODB_URI!),
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  pluginRegistry: registry,  // ← Enable automatic plugin reinstantiation
});
```

#### Making Plugins Persistable

For a plugin's configuration to be saved, it must implement the `getConfig()` method:

```typescript
class MyRAGPlugin implements RAGPlugin {
  type = 'rag' as const;
  name = '@myorg/my-rag-plugin';  // Unique identifier
  
  private config: MyPluginConfig;

  constructor(config: MyPluginConfig) {
    this.config = config;
  }

  // Return serializable configuration
  // Use env var references for sensitive values!
  getConfig() {
    return {
      // Safe: Use env var reference (not the actual secret)
      apiKey: '${MY_API_KEY}',
      mongoUri: '${MONGODB_URI}',
      
      // Safe: Non-sensitive values stored directly
      embeddingModel: this.config.embeddingModel,
      limit: this.config.limit,
    };
  }

  async retrieveContext(message: string, options: any) {
    // ... implementation
  }
}
```

#### Environment Variable References

Store sensitive values (API keys, connection strings) as environment variable references instead of actual values:

```typescript
// ✅ GOOD: Environment variable references (safe to store in DB)
getConfig() {
  return {
    openaiKey: '${OPENAI_API_KEY}',           // Required env var
    timeout: '${TIMEOUT:5000}',                // With default value
    mongoUri: '${MONGODB_URI}',
  };
}

// ❌ BAD: Actual secrets (never store in database!)
getConfig() {
  return {
    openaiKey: 'sk-actual-secret-key',  // Don't do this!
  };
}
```

The `envRef()` helper makes this cleaner:

```typescript
import { envRef } from '@snap-agent/core';

getConfig() {
  return {
    apiKey: envRef('OPENAI_API_KEY'),           // Required
    timeout: envRef('TIMEOUT', '5000'),          // With default
  };
}
```

#### Complete Example: Persistent Agents

```typescript
import { createClient, PluginRegistry, MongoDBStorage, envRef } from '@snap-agent/core';
import { EcommerceRAGPlugin } from '@snap-agent/rag-ecommerce';

// Setup registry
const registry = new PluginRegistry();
registry.register('@snap-agent/rag-ecommerce', (config) => 
  new EcommerceRAGPlugin(config)
);

const client = createClient({
  storage: new MongoDBStorage(process.env.MONGODB_URI!),
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  pluginRegistry: registry,
});

// ═══════════════════════════════════════════════════════════════════════════
// INITIAL SETUP (run once)
// ═══════════════════════════════════════════════════════════════════════════

const agent = await client.createAgent({
  name: 'Shopping Assistant',
  instructions: 'Help customers find products.',
  provider: 'openai',
  model: 'gpt-4o',
  userId: 'user-123',
  plugins: [
    new EcommerceRAGPlugin({
      mongoUri: process.env.MONGODB_URI!,
      voyageApiKey: process.env.VOYAGE_API_KEY!,
      tenantId: 'my-store',
    }),
  ],
});

console.log('Agent created:', agent.id);
// Plugin config is automatically extracted and saved to MongoDB!

// ═══════════════════════════════════════════════════════════════════════════
// AFTER SERVER RESTART (plugins automatically reinstantiated)
// ═══════════════════════════════════════════════════════════════════════════

// Later, in a different process or after restart:
const loadedAgent = await client.getAgent('agent-123');

// ✅ Plugins are automatically reinstantiated from stored config!
// The registry looked up '@snap-agent/rag-ecommerce' and called its factory
// with the stored config (env vars resolved at runtime)

const response = await client.chat({
  threadId: 'thread-456',
  message: 'Find me a red dress under $100',
  useRAG: true,  // RAG plugin works!
});
```

#### Plugin Loading Priority

When loading an agent, plugins are resolved in this order:

1. **Direct plugins** (highest priority) — Plugins passed to `getAgent()`
2. **Registry** — Reinstantiate from stored configs using registered factories  
3. **None** — Agent loads without plugins

```typescript
// Priority 1: Direct plugins (override stored configs)
const agent = await client.getAgent('agent-123', {
  plugins: [new CustomPlugin()],  // Uses this, ignores stored configs
});

// Priority 2: Use registry (automatic from client config)
const agent = await client.getAgent('agent-123');
// Uses registry to reinstantiate from stored configs

// Priority 3: Override registry for this call
const agent = await client.getAgent('agent-123', {
  registry: differentRegistry,
});
```

### Available Packages

**RAG Plugins** — Add knowledge to your agents:

| Package | Description | Links |
|---------|-------------|-------|
| `@snap-agent/rag-ecommerce` | E-commerce product search with attribute extraction | [npm](https://www.npmjs.com/package/@snap-agent/rag-ecommerce) · [github](https://github.com/vilo-hq/snap-agent/tree/main/plugins/rag/ecommerce) |
| `@snap-agent/rag-docs` | General documentation search | [github](https://github.com/vilo-hq/snap-agent/tree/main/plugins/rag/docs) |

**Middlewares** — Intercept requests/responses:

| Package | Description | Links |
|---------|-------------|-------|
| `@snap-agent/middleware-ratelimit` | Abuse prevention (100 req/min) | [github](https://github.com/vilo-hq/snap-agent/tree/main/middlewares/ratelimit) |
| `@snap-agent/middleware-budget` | Cost control ($10/day limits) | [github](https://github.com/vilo-hq/snap-agent/tree/main/middlewares/budget) |
| `@snap-agent/middleware-slack` | Slack notifications | [github](https://github.com/vilo-hq/snap-agent/tree/main/middlewares/slack) |
| `@snap-agent/middleware-discord` | Discord notifications | [github](https://github.com/vilo-hq/snap-agent/tree/main/middlewares/discord) |
| `@snap-agent/middleware-webhooks` | Custom HTTP webhooks | [github](https://github.com/vilo-hq/snap-agent/tree/main/middlewares/webhooks) |
| `@snap-agent/middleware-moderation` | Content moderation | [github](https://github.com/vilo-hq/snap-agent/tree/main/middlewares/moderation) |

**Analytics** — Track usage and performance:

| Package | Description | Links |
|---------|-------------|-------|
| `@snap-agent/analytics` | Full metrics suite (performance, cost, RAG, errors) | [github](https://github.com/vilo-hq/snap-agent/tree/main/plugins/analytics/core) |
| `@snap-agent/analytics-console` | Dev-friendly console logging | [github](https://github.com/vilo-hq/snap-agent/tree/main/plugins/analytics/console) |


## Zero-Config RAG

Add semantic search and retrieval-augmented generation to your agents with zero configuration:

```typescript
// Just add rag: { enabled: true }
const agent = await client.createAgent({
  name: 'Knowledge Assistant',
  instructions: 'You are a helpful assistant with access to a knowledge base.',
  model: 'gpt-4o',
  userId: 'user-123',
  rag: {
    enabled: true  // That's it! Uses DefaultRAGPlugin automatically
  }
});

// Ingest documents
await agent.ingestDocuments([
  {
    id: 'doc-1',
    content: 'Your document content here...',
    metadata: { title: 'Doc Title', category: 'general' }
  }
]);

// Chat with RAG
const response = await client.chat({
  threadId: thread.id,
  message: 'What does the documentation say about...?',
  useRAG: true  // Enable RAG for this query
});
```

### Advanced RAG Configuration

```typescript
const agent = await client.createAgent({
  name: 'Advanced Agent',
  model: 'gpt-4o',
  userId: 'user-123',
  rag: {
    enabled: true,
    embeddingModel: 'text-embedding-3-large', // Custom model
    limit: 10, // Return more results
    // Optional: Use different API key for embeddings
    embeddingProviderApiKey: process.env.CUSTOM_API_KEY,
  }
});
```

### Using Specialized RAG Plugins

For production use cases with advanced features (attribute extraction, rescoring, reranking, caching), use specialized plugins:

```typescript
import { EcommerceRAGPlugin } from '@snap-agent/rag-ecommerce';

const agent = await client.createAgent({
  name: 'Shopping Assistant',
  model: 'gpt-4o',
  userId: 'user-123',
  plugins: [
    new EcommerceRAGPlugin({
      mongoUri: process.env.MONGODB_URI!,
      openaiApiKey: process.env.OPENAI_API_KEY!,
      voyageApiKey: process.env.VOYAGE_API_KEY!,
      tenantId: 'my-store',
      cache: { 
        embeddings: { enabled: true },
        attributes: { enabled: true }
      }
    })
  ]
});
```

## Storage Adapters

### Upstash Redis (Edge + Server)

**Recommended for edge deployments.** Uses REST API, works everywhere.

```typescript
import { UpstashStorage } from '@snap-agent/core';

const storage = new UpstashStorage({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  prefix: 'myapp', // Optional: key prefix for multi-tenancy
});

const client = createClient({
  storage,
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
});
```

### MongoDB Storage (Server)

```typescript
import { MongoDBStorage } from '@snap-agent/core';

const storage = new MongoDBStorage({
  uri: 'mongodb://localhost:27017',
  dbName: 'myapp',
  agentsCollection: 'agents',
  threadsCollection: 'threads',
});

// Or use simple string URI
const storage = new MongoDBStorage('mongodb://localhost:27017/myapp');
```

### Memory Storage (Development/Testing)

```typescript
import { MemoryStorage } from '@snap-agent/core';

const storage = new MemoryStorage();

// Useful methods
storage.clear(); // Clear all data
console.log(storage.getStats()); // Get stats
```

### Custom Storage Adapter

Implement your own storage adapter for any database:

```typescript
import { StorageAdapter } from '@snap-agent/core';

class PostgresStorage implements StorageAdapter {
  async createAgent(config: AgentConfig): Promise<string> {
    // Your implementation
  }
  
  async getAgent(agentId: string): Promise<AgentData | null> {
    // Your implementation
  }
  
  // ... implement all required methods
}
```

## Advanced Usage

### Working with Agent and Thread Objects

```typescript
// Load and use agent directly
const agent = await client.getAgent('agent-id');
console.log(agent.name);
console.log(agent.provider);
console.log(agent.model);

// Generate response directly
const messages = [
  { role: 'user', content: 'Hello!' }
];
const reply = await agent.generateResponse(messages);

// Load and use thread directly
const thread = await client.getThread('thread-id');
await thread.addMessage('user', 'Hello!');
const messages = await thread.getMessages(10);
```

### Auto-Generate Thread Names

```typescript
const thread = await client.createThread({
  agentId: agent.id,
  userId: 'user-123',
});

// Generate a descriptive name based on first message
const name = await client.generateThreadName('Help me debug this error');
await thread.updateName(name);
```

### Message Attachments

```typescript
await client.chat({
  threadId: thread.id,
  message: 'Can you review this document?',
  attachments: [
    {
      fileId: 'file-123',
      filename: 'document.pdf',
      contentType: 'application/pdf',
      size: 1024000,
    },
  ],
});
```

### Organization Support (Multi-Tenancy)

```typescript
const agent = await client.createAgent({
  name: 'Org Agent',
  userId: 'user-123',
  organizationId: 'org-456',
  // ... other config
});

// List agents for an organization
const orgAgents = await client.listAgents('user-123', 'org-456');
```

## Error Handling

```typescript
import {
  AgentNotFoundError,
  ThreadNotFoundError,
  ProviderNotFoundError,
  InvalidConfigError,
} from '@snap-agent/core';

try {
  const agent = await client.getAgent('invalid-id');
} catch (error) {
  if (error instanceof AgentNotFoundError) {
    console.error('Agent not found:', error.message);
  } else if (error instanceof ProviderNotFoundError) {
    console.error('Provider not configured:', error.message);
  }
}
```

## Environment Variables

```bash
# .env

# LLM Providers
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AI...

# Storage (choose one)
MONGODB_URI=mongodb://localhost:27017/agents        # Server environments
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io  # Edge + Server
UPSTASH_REDIS_REST_TOKEN=your-token
```

## Examples

**Getting Started:**
- [Basic Usage](./examples/basic.ts) - Simple agent creation and chat
- [Multi-Provider](./examples/multi-provider.ts) - Using different AI providers
- [Streaming](./examples/streaming.ts) - Real-time response streaming

**RAG & Ingestion:**
- [Zero-Config RAG](./examples/zero-config-rag.ts) - RAG with zero configuration
- [Product Ingestion](./examples/product-ingestion.ts) - Ingest product catalogs
- [URL Ingestion](./examples/url-ingestion-example.ts) - Ingest from URLs

**Deployment:**
- [Express Server](./examples/express-server.ts) - Building an API server
- [Cloudflare Workers](./examples/edge-cloudflare-worker.ts) - Edge deployment
- [Vercel Edge](./examples/edge-vercel.ts) - Vercel Edge Functions

## Edge Runtime

Deploy AI agents to edge runtimes for low latency and global distribution:

```typescript
// Cloudflare Workers
import { createClient, UpstashStorage } from '@snap-agent/core';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const client = createClient({
      storage: new UpstashStorage({
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN,
      }),
      providers: { openai: { apiKey: env.OPENAI_API_KEY } },
    });

    const agent = await client.createAgent({
      name: 'Edge Agent',
      instructions: 'You are helpful.',
      provider: 'openai',
      model: 'gpt-4o-mini',
      userId: 'edge-user',
    });

    const body = await request.json() as { message: string };
    const { reply } = await agent.chat(body.message);

    return Response.json({ reply });
  },
};
```

**Supported runtimes:** Cloudflare Workers, Vercel Edge, Deno Deploy, AWS Lambda@Edge, any WinterCG-compliant runtime.

See [EDGE_RUNTIME.md](./EDGE_RUNTIME.md) for complete documentation.

## Comparison

| Feature | SnapAgent | OpenAI Agents SDK | LangChain | Vercel AI SDK |
|---------|-----------|-------------------|-----------|---------------|
| Edge Compatible | ✅ | ❌ | ❌ | ✅ |
| Multi-Provider | ✅ | OpenAI only | ✅ | ✅ |
| Plugin Architecture | RAG, Tools, Middleware | Tools only | Chains | No |
| Plugin Persistence | ✅ Registry pattern | ❌ | ❌ | N/A |
| Persistent Storage | Upstash, MongoDB | In-memory | Via integrations | No |
| Zero-Config RAG | ✅ | ❌ | ❌ | ❌ |
| Agent Management | ✅ | ✅ | Complex | No |
| Thread Management | ✅ | ✅ | ❌ | ❌ |
| TypeScript First | ✅ | ✅ | Partial | ✅ |
| Bundle Size | ~63 KB | ~150 KB | ~2 MB+ | ~15 KB |
| Self-Hosted | ✅ | ❌ | ✅ | ✅ |

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on [GitHub](https://github.com/vilo-hq/snap-agent).

## License

MIT © ViloTech

## Support
- [Vilo](https://vilotech.co)
- [GitHub Issues](https://github.com/vilo-hq/snap-agent/issues)

