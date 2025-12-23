# SnapAgent SDK Examples

This directory contains comprehensive examples demonstrating various features and use cases of the SnapAgent SDK.

## Prerequisites

All examples require:
- Node.js 18 or higher
- TypeScript configured
- Environment variables set

### Environment Variables

Create a `.env` file in the project root:

```bash
# Required for all examples
OPENAI_API_KEY=sk-...

# Required for MongoDB storage examples
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net

# Required for RAG examples
VOYAGE_API_KEY=pa-...
```

## Examples

### basic.ts

**Purpose:** Introduction to core SDK functionality

**Features:**
- Agent creation with OpenAI
- Thread management
- Simple conversations
- In-memory storage for quick testing

**Run:**
```bash
npx ts-node sdk/examples/basic.ts
```

**Use Case:** Getting started, understanding SDK basics

---

### streaming.ts

**Purpose:** Real-time streaming responses

**Features:**
- Streaming text generation
- Chunk-by-chunk processing
- Real-time user feedback
- Completion callbacks

**Run:**
```bash
npx ts-node sdk/examples/streaming.ts
```

**Use Case:** Building chat interfaces with real-time responses

---

### multi-provider.ts

**Purpose:** Using multiple AI providers

**Features:**
- OpenAI, Anthropic, and Google providers
- Provider comparison
- Model switching
- Unified API across providers

**Run:**
```bash
# Requires API keys for all providers
export ANTHROPIC_API_KEY=sk-ant-...
export GOOGLE_API_KEY=...
npx ts-node sdk/examples/multi-provider.ts
```

**Use Case:** Multi-provider applications, A/B testing models

---

### express-server.ts

**Purpose:** Production-ready REST API server with RAG document management

**Features:**
- Express.js integration
- RESTful endpoints for agents, threads, and chat
- RAG document ingestion and management
- Server-Sent Events (SSE) for streaming responses
- Thread persistence with MongoDB
- Comprehensive error handling
- Health check endpoint

**Endpoints:**

**Agent Management:**
- `POST /api/agents` - Create agent
- `GET /api/agents` - List agents

**Thread Management:**
- `POST /api/threads` - Create thread
- `GET /api/threads` - List threads
- `GET /api/threads/:id/messages` - Get messages

**Chat:**
- `POST /api/chat` - Chat (non-streaming)
- `POST /api/chat/stream` - Chat with streaming (SSE)

**RAG Document Management:**
- `POST /api/agents/:id/documents` - Ingest documents (bulk)
- `PUT /api/agents/:id/documents/:docId` - Update document
- `DELETE /api/agents/:id/documents/:docIds` - Delete document(s)
- `POST /api/agents/:id/documents/bulk` - Bulk operations

**Health:**
- `GET /health` - Health check

**Run:**
```bash
npm install express
export MONGODB_URI="mongodb://localhost:27017/agents"
export OPENAI_API_KEY="sk-..."
npx ts-node sdk/examples/express-server.ts
```

**Test:**
```bash
# 1. Create agent
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{"name":"Shopping Assistant","instructions":"You are helpful","model":"gpt-4o","userId":"user-1"}'

# 2. Create thread
curl -X POST http://localhost:3000/api/threads \
  -H "Content-Type: application/json" \
  -d '{"agentId":"agent-xxx","userId":"user-1"}'

# 3. Ingest products
curl -X POST http://localhost:3000/api/agents/agent-xxx/documents \
  -H "Content-Type: application/json" \
  -d '{
    "documents": [{
      "id": "PROD-001",
      "content": "Black leather jacket",
      "metadata": {"price": 299.99, "category": "Jackets"}
    }]
  }'

# 4. Chat (retrieves products via RAG)
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"threadId":"thread-xxx","message":"Show me jackets"}'

# 5. Update product
curl -X PUT http://localhost:3000/api/agents/agent-xxx/documents/PROD-001 \
  -H "Content-Type: application/json" \
  -d '{"document": {"metadata": {"price": 279.99}}}'

# 6. Streaming chat
curl -N http://localhost:3000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"threadId":"thread-xxx","message":"Tell me more"}'
```

**Use Case:** 
- Production REST APIs
- Web applications with real-time chat
- Mobile backends
- E-commerce product management
- Content management systems
- Multi-tenant applications

---

### shopping-assistant.ts

**Purpose:** E-commerce shopping assistant with RAG plugin

**Features:**
- Product search with vector embeddings
- Attribute extraction (color, brand, price, etc.)
- Multi-turn conversations with context
- MongoDB Atlas vector search
- Intelligent caching (embeddings + attributes)
- Business metrics integration (popularity, CTR, sales)
- Soft rescoring and reranking
- Performance monitoring

**Prerequisites:**
1. MongoDB Atlas with vector search enabled
2. Products collection with embeddings
3. All required environment variables

**MongoDB Setup:**
```javascript
// Create vector search index
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

// Sample product document
{
  tenantId: "luxora-store",
  sku: "JKT-001",
  title: "Modern Leather Jacket",
  description: "Stylish men's leather jacket with modern fit",
  embedding: [...], // 1024-dim vector from Voyage
  attributes: {
    category: "Jackets",
    brand: "UrbanStyle",
    color: "Black",
    material: "Genuine Leather",
    size: ["S", "M", "L", "XL"],
    gender: "M",
    price: 299.99
  },
  inStock: true,
  metrics: {
    popularity: 0.85,
    ctr: 0.12,
    sales: 245
  }
}
```

**Run:**
```bash
# Install RAG plugin
npm install @snap-agent/rag-ecommerce

# Set all required environment variables
export MONGODB_URI=mongodb+srv://...
export OPENAI_API_KEY=sk-...
export VOYAGE_API_KEY=pa-...

# Run example
npx ts-node sdk/examples/shopping-assistant.ts
```

**Expected Output:**
- Agent creation confirmation
- Four customer queries with intelligent responses
- Product recommendations with relevance scores
- Extracted attributes from queries
- Cache performance statistics (hit rates, cost savings)
- Session summary

**Sample Conversation:**
```
Customer: "I'm looking for a stylish leather jacket for men"
Assistant: [Shows relevant products with details]

Customer: "Do you have any in black? My budget is $200-300"
Assistant: [Filters by color and price, shows matches]

Customer: "I like the second option. Does it come in large?"
Assistant: [Provides size availability and material details]

Customer: "Can you suggest boots that would go with that jacket?"
Assistant: [Cross-category recommendations]
```

**Performance:**
- Cache hit rate: 70-85% after warmup
- Cost reduction: 50-80% with caching
- Response time: 180-400ms with cache, 600-800ms without
- Supports: 1000s of products, multiple categories

**Use Case:** 
- E-commerce product search
- Fashion recommendations
- Multi-category retail
- Personalized shopping experiences
- Customer support with product knowledge

---

### product-ingestion.ts

**Purpose:** Ingest and manage product data in RAG systems

**Features:**
- Bulk product ingestion with automatic embedding generation
- Single product updates (price, stock, attributes)
- Product deletion
- Bulk operations (insert, update, delete in one call)
- Test search after ingestion
- Error handling and validation
- Progress monitoring

**Prerequisites:**
1. MongoDB Atlas with vector search index
2. All required environment variables
3. RAG plugin installed

**Run:**
```bash
# Install RAG plugin
npm install @snap-agent/rag-ecommerce

# Set environment variables
export MONGODB_URI=mongodb+srv://...
export OPENAI_API_KEY=sk-...
export VOYAGE_API_KEY=pa-...

# Run ingestion
npx ts-node sdk/examples/product-ingestion.ts
```

**What It Does:**

1. **Bulk Ingestion**: Adds 3 products (jackets, boots)
2. **Update**: Modifies price and metrics for one product
3. **Bulk Operations**: Inserts new product, updates existing one
4. **Search Test**: Queries products to verify ingestion
5. **Deletion**: Removes a product

**Example Code:**
```typescript
// Ingest products
const products = [{
  id: 'JKT-001',
  content: 'Modern black leather jacket...',
  metadata: {
    title: 'Modern Leather Jacket',
    category: 'Jackets',
    brand: 'UrbanStyle',
    price: 299.99,
    // ... more attributes
  }
}];

const results = await agent.ingestDocuments(products);

// Update product
await agent.updateDocument('JKT-001', {
  metadata: { price: 279.99 }
});

// Delete product
await agent.deleteDocuments('JKT-001');

// Bulk operations
await agent.bulkDocumentOperations([
  { type: 'insert', id: 'SHOE-001', document: {...} },
  { type: 'update', id: 'BOOT-001', document: {...} },
  { type: 'delete', id: 'OLD-001' }
]);
```

**Output:**
- Ingestion results (success/failure counts)
- Update confirmations
- Bulk operation summaries
- Search test results showing indexed products
- Deletion counts

**Use Case:**
- Product catalog management
- Dynamic inventory updates
- Real-time product availability
- Batch product imports
- E-commerce data pipelines
- Content management systems

---

## Installation

Install dependencies for all examples:

```bash
# Core dependencies
npm install @snap-agent/core

# For MongoDB examples
npm install mongodb

# For Express example
npm install express cors
npm install -D @types/express @types/cors

# For RAG examples
npm install @snap-agent/rag-ecommerce
```

## Running Examples

Each example is self-contained and can be run independently:

```bash
# Basic usage
npx ts-node sdk/examples/basic.ts

# With environment variables inline
OPENAI_API_KEY=sk-... npx ts-node sdk/examples/basic.ts

# With .env file (recommended)
# 1. Create .env file with your keys
# 2. Use dotenv or export variables
# 3. Run example
```

## Development

To modify and test examples:

```bash
# Install development dependencies
npm install -D typescript ts-node @types/node

# Run with TypeScript directly
npx ts-node sdk/examples/[example-name].ts

# Build SDK first (if testing local changes)
cd sdk
npm run build
cd ..
npx ts-node sdk/examples/[example-name].ts
```

## Common Issues

### "Module not found" errors
- Ensure you've installed all required dependencies
- Check that you're running from the project root
- Verify SDK is built: `cd sdk && npm run build`

### "Missing API key" errors
- Set all required environment variables
- Check variable names match exactly
- Use `.env` file or export in shell

### MongoDB connection errors
- Verify MongoDB URI is correct
- Check network access in MongoDB Atlas
- Ensure database user has proper permissions

### RAG plugin errors
- Verify vector search index exists
- Check collection has documents with embeddings
- Ensure Voyage API key is valid
- Confirm product schema matches expected format

## Best Practices

1. **Environment Variables:** Never commit API keys, use `.env` files
2. **Error Handling:** All examples include proper error handling patterns
3. **Cleanup:** Examples clean up resources (connections, threads)
4. **Logging:** Use console output to understand execution flow
5. **Production:** Adapt examples for production (add monitoring, rate limiting, etc.)

## Resources

- [SnapAgent SDK Documentation](../README.md)
- [RAG E-commerce Plugin](../../plugins/rag-ecommerce/README.md)
- [API Reference](../../docs/API_REFERENCE.md)
- [GitHub Repository](https://github.com/vilotech/snap-agent)

## Support

For questions or issues:
- Open an issue on GitHub
- Check existing documentation
- Review example code comments

