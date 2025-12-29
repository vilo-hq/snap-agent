# @snap-agent/rag-ecommerce

E-commerce RAG plugin for SnapAgent SDK - Sophisticated product search and recommendations with vector embeddings.

## Features

- **Vector Search** - MongoDB Atlas with Voyage AI embeddings
- **Smart Attribute Extraction** - AI-powered query understanding
- **Soft Rescoring** - Attribute matching + business metrics
- **Optional Reranking** - Voyage reranker for precision
- **Built-in Caching** - 50-80% cost & latency reduction
- **Multilingual** - Spanish and English support
- **Fully Configurable** - Tune every aspect  

## Installation

```bash
npm install @snap-agent/rag-ecommerce @snap-agent/core
```

## Quick Start

```typescript
import { createClient, MongoDBStorage } from '@snap-agent/core';
import { EcommerceRAGPlugin } from '@snap-agent/rag-ecommerce';

const client = createClient({
  storage: new MongoDBStorage(process.env.MONGODB_URI!),
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
  },
});

const agent = await client.createAgent({
  name: 'Shopping Assistant',
  instructions: 'You are a helpful shopping assistant.',
  model: 'gpt-4o',
  userId: 'user-123',
  plugins: [
    new EcommerceRAGPlugin({
      mongoUri: process.env.MONGODB_URI!,
      openaiApiKey: process.env.OPENAI_API_KEY!,
      voyageApiKey: process.env.VOYAGE_API_KEY!,
      tenantId: 'my-store',
    }),
  ],
});

const thread = await client.createThread({
  agentId: agent.id,
  userId: 'user-123',
});

const response = await client.chat({
  threadId: thread.id,
  message: 'I want red sneakers under $100',
  useRAG: true,
});
```

## How It Works

### 1. Query Understanding
```
User: "red nike running shoes under $100"
↓
Attribute Extraction (OpenAI):
{
  color: "red",
  brand: "nike",
  category: "running shoes",
  priceMax: 100
}
```

### 2. Vector Search
```
Query → Embedding (Voyage) → MongoDB Atlas Vector Search
↓
Returns: Top 50 semantically similar products
```

### 3. Soft Rescoring
```
Base score + Attribute matches + Business metrics
- Color match: +0.15
- Brand match: +0.08
- Popularity: +0.05
- CTR: +0.10
↓
Re-ranked by combined score
```

### 4. Optional Reranking
```
Top 50 → Voyage Reranker → Top 10 most relevant
```

### 5. Context Injection
```
Top 8 products → Formatted context → Injected into LLM prompt
```

## Configuration

### Basic
```typescript
new EcommerceRAGPlugin({
  mongoUri: process.env.MONGODB_URI!,
  openaiApiKey: process.env.OPENAI_API_KEY!,
  voyageApiKey: process.env.VOYAGE_API_KEY!,
  tenantId: 'my-store',
})
```

### Advanced
```typescript
new EcommerceRAGPlugin({
  // Required
  mongoUri: process.env.MONGODB_URI!,
  openaiApiKey: process.env.OPENAI_API_KEY!,
  voyageApiKey: process.env.VOYAGE_API_KEY!,
  tenantId: 'my-store',
  
  // Customize attributes
  attributeList: ['category', 'color', 'brand', 'price', 'size', 'style'],
  
  // Tune scoring weights
  rescoringWeights: {
    color: 0.20,
    brand: 0.15,
    category: 0.10,
    popularity: 0.15,
  },
  
  // Enable reranking
  enableReranking: true,
  rerankTopK: 5,
  
  // Cache configuration
  cache: {
    embeddings: { enabled: true, ttl: 3600000, maxSize: 2000 },
    attributes: { enabled: true, ttl: 1800000, maxSize: 1000 },
  },
  
  // Context
  contextProductCount: 10,
  language: 'en',
  includeOutOfStock: false,
})
```

## Caching

Built-in intelligent caching for dramatic performance improvements:

```typescript
const stats = plugin.getCacheStats();
console.log(stats);
// {
//   embeddings: { hits: 1250, misses: 320, hitRate: '0.80' },
//   attributes: { hits: 890, misses: 210, hitRate: '0.81' }
// }
```

**Benefits:**
- 50-80% cost reduction
- 5-10x faster for repeat queries
- Automatic cleanup
- Zero configuration required

See [CACHING.md](./CACHING.md) for details.

## Database Schema

### Products Collection
```typescript
{
  tenantId: string,
  agentId?: string,
  sku: string,
  title: string,
  description?: string,
  embedding: number[], // 1024-dim vector
  attributes: {
    category?: string,
    brand?: string,
    color?: string,
    material?: string,
    size?: string[],
    price?: number,
    gender?: 'M' | 'F' | 'Unisex',
  },
  inStock?: boolean,
  metrics?: {
    popularity?: number,
    ctr?: number,
    sales?: number,
  }
}
```

### Required Indexes
```javascript
// Vector search index
db.products.createSearchIndex({
  name: "product_vector_index",
  type: "vectorSearch",
  definition: {
    fields: [{
      type: "vector",
      path: "embedding",
      numDimensions: 1024,
      similarity: "cosine"
    }]
  }
});
```

## Environment Variables

```bash
MONGODB_URI=mongodb+srv://...
OPENAI_API_KEY=sk-...
VOYAGE_API_KEY=pa-...
```

## Performance

| Metric | Without RAG | With RAG | With RAG + Cache |
|--------|------------|----------|------------------|
| Latency | 200ms | 600ms | 180ms |
| Cost/query | $0.0005 | $0.0008 | $0.0003 |
| Relevance | Low | High | High |

## Examples

See [example-cache.ts](./example-cache.ts) for a complete working example with cache monitoring.

## API Reference

### Methods

#### `retrieveContext(message, options)`
Main retrieval method (called by SDK automatically)

**Returns:**
```typescript
{
  content: string,           // Formatted product list
  sources: [...],           // Top products with scores
  metadata: {
    productCount: number,
    extractedAttributes: {...},
    topProducts: [...]
  }
}
```

#### `getCacheStats()`
Get cache performance statistics

#### `clearCache()`
Clear all caches

#### `disconnect()`
Cleanup MongoDB connection

## License

MIT © ViloTech

## Support

- [ViloTech]("https://vilotech.co")
- [Documentation](../../sdk/README.md)
- [GitHub Issues](https://github.com/vilotech/snap-agent/issues)
- [SnapAgent SDK](https://github.com/vilotech/snap-agent)

