# Quick Reference: Plugin System

## Creating an Agent with RAG Plugin

```typescript
import { createClient, MongoDBStorage } from './sdk/src';
import { EcommerceRAGPlugin } from './plugins/rag-ecommerce/src';

const client = createClient({
  storage: new MongoDBStorage(process.env.MONGODB_URI!),
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
  },
});

const agent = await client.createAgent({
  name: 'Shopping Assistant',
  instructions: 'Eres un asistente de ventas experto.',
  model: 'gpt-4o',
  userId: 'user-123',
  plugins: [
    new EcommerceRAGPlugin({
      mongoUri: process.env.MONGODB_URI!,
      openaiApiKey: process.env.OPENAI_API_KEY!,
      voyageApiKey: process.env.VOYAGE_API_KEY!,
      tenantId: 'my-store',
      language: 'es',
      contextProductCount: 8,
      enableReranking: false,
    }),
  ],
});
```

## Chatting with RAG

```typescript
// Non-streaming
const response = await client.chat({
  threadId: 'thread-123',
  message: 'Looking for red sneakers under $100',
  useRAG: true,  // Enable RAG plugins
  ragFilters: { category: 'shoes' }, // Optional filters
});

console.log(response.reply);
console.log(response.metadata); // RAG metadata
```

## Streaming with RAG

```typescript
await client.chatStream(
  {
    threadId: 'thread-123',
    message: 'Show me summer dresses',
    useRAG: true,
  },
  {
    onChunk: (chunk) => process.stdout.write(chunk),
    onComplete: (fullResponse) => console.log('\nDone!'),
    onError: (error) => console.error('Error:', error),
  }
);
```

## Adding Plugin Dynamically

```typescript
const agent = await client.getAgent('agent-123');

agent.addPlugin(
  new EcommerceRAGPlugin({
    mongoUri: process.env.MONGODB_URI!,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    voyageApiKey: process.env.VOYAGE_API_KEY!,
    tenantId: 'different-store',
  })
);

// Now agent has RAG capabilities!
```

## Customizing Plugin Behavior

```typescript
new EcommerceRAGPlugin({
  // Required
  mongoUri: process.env.MONGODB_URI!,
  openaiApiKey: process.env.OPENAI_API_KEY!,
  voyageApiKey: process.env.VOYAGE_API_KEY!,
  tenantId: 'my-store',
  
  // Customize attribute extraction
  attributeList: ['category', 'color', 'brand', 'price', 'size'],
  
  // Adjust scoring weights
  rescoringWeights: {
    color: 0.20,
    brand: 0.15,
    category: 0.10,
    popularity: 0.15,
  },
  
  // Enable reranking for better results
  enableReranking: true,
  rerankTopK: 5,
  
  // Context configuration
  contextProductCount: 10,
  language: 'en',
  includeOutOfStock: false,
})
```

## Using in Express Routes

```typescript
import { Router } from 'express';
import { createClient } from './sdk/src';
import { EcommerceRAGPlugin } from './plugins/rag-ecommerce/src';

const router = Router();

router.post('/chat', async (req, res) => {
  const { agentId, threadId, message } = req.body;
  
  const response = await client.chat({
    threadId,
    message,
    useRAG: true, // Enable RAG!
  });
  
  res.json(response);
});
```

## Multiple Plugins (Future)

```typescript
const agent = await client.createAgent({
  name: 'Hybrid Assistant',
  // ...
  plugins: [
    // Products RAG
    new EcommerceRAGPlugin({ /* config */ }),
    
    // Documents RAG (when available)
    new DocumentRAGPlugin({ /* config */ }),
    
    // Analytics (when available)
    new PostHogAnalyticsPlugin({ /* config */ }),
  ],
});
```

## Environment Variables

```bash
# .env
MONGODB_URI=mongodb://localhost:27017/agentStudio
OPENAI_API_KEY=sk-...
VOYAGE_API_KEY=pa-...
```

## Building

```bash
# Build SDK
cd sdk && pnpm build

# Build Plugin
cd plugins/rag-ecommerce && pnpm build
```

## Testing

```bash

npm start

# Test RAG chat
curl -X POST http://localhost:3000/api/v2/rag/chat/non-stream \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "...",
    "threadId": "...",
    "message": "red sneakers under $100"
  }'
```

That's it! Your plugin system is ready to use.


