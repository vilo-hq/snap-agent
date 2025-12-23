# Edge Runtime Support

SnapAgent SDK is fully compatible with edge runtimes, allowing you to deploy AI agents to:

- **Cloudflare Workers**
- **Vercel Edge Functions**
- **Deno Deploy**
- **AWS Lambda@Edge**
- **Any WinterCG-compliant runtime**

## Why Edge?

| Benefit | Description |
|---------|-------------|
| **Low Latency** | Deploy closer to users globally |
| **Cost Efficient** | Pay per request, no idle servers |
| **Auto-scaling** | Handles traffic spikes automatically |
| **Simple Deployment** | No infrastructure management |

## Quick Start

### Cloudflare Workers

```typescript
import { createClient, MemoryStorage } from '@snap-agent/core';

export interface Env {
  OPENAI_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const client = createClient({
      storage: new MemoryStorage(),
      providers: {
        openai: { apiKey: env.OPENAI_API_KEY },
      },
    });

    const agent = await client.createAgent({
      name: 'Edge Agent',
      instructions: 'You are a helpful assistant running on the edge.',
      provider: 'openai',
      model: 'gpt-4o-mini',
      userId: 'edge-user',
    });

    const { reply } = await agent.chat('Hello from the edge!');

    return new Response(JSON.stringify({ reply }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
```

### Vercel Edge Functions

```typescript
import { createClient, MemoryStorage } from '@snap-agent/core/edge';

export const config = {
  runtime: 'edge',
};

export default async function handler(request: Request) {
  const client = createClient({
    storage: new MemoryStorage(),
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  });

  const agent = await client.createAgent({
    name: 'Vercel Edge Agent',
    instructions: 'You are helpful.',
    provider: 'openai',
    model: 'gpt-4o-mini',
    userId: 'vercel-user',
  });

  const body = await request.json();
  const { reply } = await agent.chat(body.message);

  return new Response(JSON.stringify({ reply }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
```

### Deno Deploy

```typescript
import { createClient, MemoryStorage } from 'npm:@snap-agent/core';

Deno.serve(async (request: Request) => {
  const client = createClient({
    storage: new MemoryStorage(),
    providers: {
      openai: { apiKey: Deno.env.get('OPENAI_API_KEY')! },
    },
  });

  const agent = await client.createAgent({
    name: 'Deno Agent',
    instructions: 'You are helpful.',
    provider: 'openai',
    model: 'gpt-4o-mini',
    userId: 'deno-user',
  });

  const { reply } = await agent.chat('Hello from Deno!');

  return new Response(JSON.stringify({ reply }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
```

## Zero-Config RAG on Edge

The built-in `DefaultRAGPlugin` works on edge runtimes out of the box:

```typescript
const agent = await client.createAgent({
  name: 'RAG Edge Agent',
  instructions: 'Answer questions using provided context.',
  provider: 'openai',
  model: 'gpt-4o-mini',
  userId: 'edge-user',
  rag: { enabled: true }, // Works on edge!
});

// Ingest documents (in-memory on edge)
await agent.ingestDocuments([
  { id: 'doc1', content: 'Product info...' },
  { id: 'doc2', content: 'FAQ answers...' },
]);

// Chat with RAG context
const { reply } = await agent.chat('What products do you have?', {
  useRAG: true,
});
```

## Storage Options

### In-Memory (Default for Edge)

```typescript
import { MemoryStorage } from '@snap-agent/core';

const client = createClient({
  storage: new MemoryStorage(),
  // ...
});
```

**Note:** Memory storage is ephemeral. Data is lost when the worker restarts.

### Upstash Redis (Recommended for Edge)

Upstash provides a REST-based Redis that works on all edge runtimes. No TCP connections required.

```typescript
import { UpstashStorage } from '@snap-agent/core/storage';

const storage = new UpstashStorage({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const client = createClient({
  storage,
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
});
```

#### Cloudflare Workers with Upstash

```typescript
import { createClient, UpstashStorage } from '@snap-agent/core';

export interface Env {
  OPENAI_API_KEY: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const storage = new UpstashStorage({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });

    const client = createClient({
      storage,
      providers: { openai: { apiKey: env.OPENAI_API_KEY } },
    });

    // Now you have persistent storage on edge!
    const agent = await client.createAgent({
      name: 'Persistent Edge Agent',
      instructions: 'You remember conversations.',
      provider: 'openai',
      model: 'gpt-4o-mini',
      userId: 'edge-user',
    });

    const body = await request.json() as { message: string; threadId?: string };
    
    // Conversations persist across requests
    const thread = body.threadId 
      ? await agent.getThread(body.threadId)
      : await agent.createThread();

    const { reply } = await thread.chat(body.message);

    return new Response(JSON.stringify({ 
      reply, 
      threadId: thread.getId() 
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
```

#### Vercel Edge with Upstash

```typescript
import { createClient, UpstashStorage } from '@snap-agent/core/edge';

export const config = { runtime: 'edge' };

export default async function handler(request: Request) {
  const storage = new UpstashStorage({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const client = createClient({
    storage,
    providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  });

  const agent = await client.createAgent({
    name: 'Vercel Edge Agent',
    instructions: 'You are helpful and remember past conversations.',
    provider: 'openai',
    model: 'gpt-4o-mini',
    userId: 'vercel-user',
  });

  const body = await request.json() as { message: string };
  const { reply } = await agent.chat(body.message);

  return new Response(JSON.stringify({ reply }));
}
```

#### Configuration Options

```typescript
const storage = new UpstashStorage({
  url: 'https://your-redis.upstash.io',
  token: 'your-token',
  prefix: 'myapp', // Optional: key prefix for multi-tenancy (default: 'snap-agent')
});

// Utility methods
await storage.ping();      // Test connection
await storage.getStats();  // Get agent/thread counts
await storage.clear();     // Clear all data (use carefully!)
```

### Other Edge Storage (Coming Soon)

- `@snap-agent/storage-cloudflare-kv` - Cloudflare KV
- `@snap-agent/storage-cloudflare-d1` - Cloudflare D1 (SQLite)
- `@snap-agent/storage-turso` - Turso (distributed SQLite)

## What's NOT Available on Edge

| Feature | Reason | Alternative |
|---------|--------|-------------|
| MongoDB Storage | Node.js native driver | Use Upstash, Cloudflare KV |
| File system | No `fs` module | Use KV or external storage |

## Bundle Size

SnapAgent is optimized for edge deployments:

| Package | Size (gzip) | Notes |
|---------|-------------|-------|
| `@snap-agent/core` | ~35 KB | Core SDK |
| `ai` (Vercel AI SDK) | ~15 KB | Peer dependency |
| `zod` | ~13 KB | Validation |
| **Total** | **~63 KB** | vs LangChain's 2MB+ |

## Streaming on Edge

Streaming responses work seamlessly:

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const client = createClient({
      storage: new MemoryStorage(),
      providers: { openai: { apiKey: env.OPENAI_API_KEY } },
    });

    const agent = await client.createAgent({
      name: 'Streaming Agent',
      instructions: 'You are helpful.',
      provider: 'openai',
      model: 'gpt-4o-mini',
      userId: 'edge-user',
    });

    // Create a readable stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        await agent.chatStream('Tell me a story', {
          onChunk: (chunk) => {
            controller.enqueue(encoder.encode(chunk));
          },
        });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
```

## Environment Variables

### Cloudflare Workers

Use `wrangler.toml` secrets:

```toml
[vars]
# Non-sensitive
SOME_VAR = "value"

# Run: wrangler secret put OPENAI_API_KEY
```

### Vercel Edge

Use Vercel environment variables (dashboard or `.env.local`).

### Deno Deploy

Use `Deno.env.get()` with environment variables set in the dashboard.

## Comparison

| Feature | SnapAgent | OpenAI Agents SDK | LangChain |
|---------|-----------|-------------------|-----------|
| Edge Compatible | ✅ | ❌ | ❌ |
| Bundle Size | ~63 KB | ~150 KB | ~2 MB+ |
| Multi-Provider | OpenAI, Anthropic, Google | OpenAI only | ✅ |
| Zero-Config RAG | ✅ | Manual setup | Manual setup |
| Persistent Storage | Upstash, MongoDB, Memory | In-memory only | Via integrations |
| TypeScript Native | ✅ | ✅ | Partial |
| Streaming | Native | Native | Complex |
| Thread Management | Built-in | Built-in | Manual |
| Plugin System | RAG, Tools, Middleware | Tools only | Chains/Agents |

---

SnapAgent: **The AI Agent SDK that runs everywhere.**

