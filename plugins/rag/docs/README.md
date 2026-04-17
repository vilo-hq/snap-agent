# @snap-agent/rag-docs

Documentation RAG plugin for SnapAgent SDK - Semantic search over markdown, code, and technical documentation.

> 🚀 **First time?** See [QUICKSTART.md](./QUICKSTART.md) for a complete step-by-step setup.

## Features

- **Smart Chunking** - Markdown-aware, paragraph, sentence, or fixed-size strategies
- **Code-Aware** - Extracts and indexes code blocks with language detection
- **Section Hierarchy** - Preserves heading structure for context
- **Semantic Search** - OpenAI embeddings for natural language queries
- **MongoDB Storage** - Persistent vector storage with Atlas Search
- **Embedding Cache** - Reduces API costs and improves performance
- **Similarity Filtering** - Configurable minimum score threshold

## Installation

```bash
npm install @snap-agent/rag-docs @snap-agent/core mongodb
```

## MongoDB Setup

This plugin requires MongoDB Atlas with vector search capabilities.

### 1. Create a MongoDB Atlas Cluster

1. Sign up at [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
2. Create a cluster (M10+ recommended for vector search)
3. Get your connection string

### 2. Create Vector Search Index

In the Atlas UI, create this index on your `docs_content` collection:

**📘 [Visual Step-by-Step Guide →](./docs/ATLAS_SETUP_GUIDE.md)**

**JSON Configuration:**

```json
{
  "name": "docs_vector_index",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      {
        "type": "vector",
        "path": "embedding",
        "numDimensions": 1536,
        "similarity": "cosine"
      },
      {
        "type": "filter",
        "path": "tenantId"
      },
      {
        "type": "filter",
        "path": "agentId"
      },
      {
        "type": "filter",
        "path": "metadata.type"
      },
      {
        "type": "filter",
        "path": "metadata.section"
      }
    ]
  }
}
```

**Note:** If using `text-embedding-3-large`, change `numDimensions` to `3072`.

### 3. Verify Index Creation

**Option A: Use .env file (recommended)**

Create `sdk/examples/docs-rag/.env`:
```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/
OPENAI_API_KEY=sk-proj-xxxxx
```

Then run:
```bash
cd sdk/examples/docs-rag
npx tsx verify-index.ts
```

**Option B: Environment variables in terminal**

```bash
cd sdk/examples/docs-rag
export MONGODB_URI="your-connection-string"
export OPENAI_API_KEY="sk-..."
npx tsx verify-index.ts
```

The script will verify:
- ✅ Connection to MongoDB
- ✅ Collection existence
- ✅ Vector index status

### 4. Test the Plugin

With `.env` already configured:
```bash
cd sdk/examples/docs-rag
npx tsx test-plugin.ts
```

Or with environment variables:
```bash
export MONGODB_URI="mongodb+srv://..."
export OPENAI_API_KEY="sk-..."
pnpm test-plugin
```

This script:
- Ingests a sample document
- Performs test searches
- Shows cache statistics
- Verifies persistence

## Quick Start

```typescript
import { createClient, MemoryStorage } from '@snap-agent/core';
import { DocsRAGPlugin } from '@snap-agent/rag-docs';

const client = createClient({
  storage: new MemoryStorage(),
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
  },
});

const agent = await client.createAgent({
  name: 'Docs Assistant',
  instructions: 'You help users understand the documentation.',
  model: 'gpt-4o',
  userId: 'user-123',
  plugins: [
    new DocsRAGPlugin({
      // MongoDB connection
      mongoUri: process.env.MONGODB_URI!,
      dbName: 'my_docs',
      tenantId: 'my-company',
      
      // Embeddings
      embeddingProviderApiKey: process.env.OPENAI_API_KEY!,
      chunkingStrategy: 'markdown',
    }),
  ],
});

// Ingest documentation
await agent.ingestDocuments([
  {
    id: 'getting-started',
    content: `# Getting Started

Welcome to our platform!

## Installation

\`\`\`bash
npm install our-package
\`\`\`

## Basic Usage

First, initialize the client:

\`\`\`typescript
import { Client } from 'our-package';
const client = new Client();
\`\`\`
`,
    metadata: { title: 'Getting Started Guide' },
  },
]);

// Query the docs
const response = await client.chat({
  threadId: thread.id,
  message: 'How do I install the package?',
  useRAG: true,
});
```

## Configuration

```typescript
const plugin = new DocsRAGPlugin({
  // MongoDB (required)
  mongoUri: process.env.MONGODB_URI!,
  dbName: 'my_docs',
  collection: 'docs_content',        // Default: 'docs_content'
  tenantId: 'my-company',            // Required for multi-tenancy

  // Required
  embeddingProviderApiKey: process.env.OPENAI_API_KEY!,

  // Embedding Provider (optional)
  embeddingProvider: 'openai',  // 'openai' | 'voyage' (default: 'openai')
  embeddingModel: 'text-embedding-3-small', // Model to use

  // Vector Search
  vectorIndexName: 'docs_vector_index',  // Atlas Search index name
  numCandidates: 100,                    // Candidates for vector search

  // Chunking
  chunkingStrategy: 'markdown', // 'markdown' | 'paragraph' | 'sentence' | 'fixed'
  maxChunkSize: 1000,           // Max characters per chunk
  chunkOverlap: 200,            // Overlap for fixed strategy

  // Search
  limit: 5,                     // Results to return
  minSimilarity: 0.7,           // Minimum similarity score (0-1)

  // Options
  includeCode: true,            // Index code blocks
  
  // Filterable fields for MongoDB indexing
  filterableFields: ['type', 'section', 'language'],
  
  // Embedding cache (recommended)
  cache: {
    embeddings: {
      enabled: true,
      ttl: 3600000,     // 1 hour
      maxSize: 1000,
    },
  },

  // Plugin priority
  priority: 100,
});
```

## Embedding Providers

### OpenAI (Default)

Best for English-focused documentation with excellent general-purpose embeddings.

```typescript
const plugin = new DocsRAGPlugin({
  embeddingProviderApiKey: process.env.OPENAI_API_KEY!,
  embeddingProvider: 'openai',
  embeddingModel: 'text-embedding-3-small', // or 'text-embedding-3-large'
});
```

### Voyage AI

Better multilingual support and cost-effective for high-volume use cases.

```typescript
const plugin = new DocsRAGPlugin({
  embeddingProviderApiKey: process.env.VOYAGE_API_KEY!,
  embeddingProvider: 'voyage',
  embeddingModel: 'voyage-3-lite', // or 'voyage-3', 'voyage-multilingual-2'
});
```

| Provider | Default Model | Best For |
|----------|--------------|----------|
| OpenAI | `text-embedding-3-small` | English docs, simplicity |
| Voyage | `voyage-3-lite` | Multilingual, cost optimization |

## Chunking Strategies

### `markdown` (Recommended for docs)
- Preserves heading hierarchy
- Extracts code blocks separately
- Maintains section context
- Best for technical documentation

### `paragraph`
- Splits on double newlines
- Good for prose-heavy content
- Maintains natural reading units

### `sentence`
- Splits on sentence boundaries
- Best for Q&A style content
- Granular retrieval

### `fixed`
- Fixed-size chunks with overlap
- Consistent chunk sizes
- Good for uniform content

## Ingesting Documents

### Single Document

```typescript
await agent.ingestDocuments([
  {
    id: 'api-reference',
    content: '# API Reference\n\n...',
    metadata: {
      title: 'API Reference',
      category: 'reference',
      version: '1.0.0',
    },
  },
]);
```

### From Files (Example)

```typescript
import fs from 'fs';
import path from 'path';

const docsDir = './docs';
const files = fs.readdirSync(docsDir);

const documents = files
  .filter(f => f.endsWith('.md'))
  .map(file => ({
    id: path.basename(file, '.md'),
    content: fs.readFileSync(path.join(docsDir, file), 'utf-8'),
    metadata: { filename: file },
  }));

await agent.ingestDocuments(documents);
```

## Filtering Results

```typescript
const response = await client.chat({
  threadId: thread.id,
  message: 'Show me code examples',
  useRAG: true,
  ragFilters: {
    type: 'code',     // Only return code chunks
    section: 'Usage', // Only from "Usage" sections
  },
});
```

## Response Metadata

```typescript
const response = await client.chat({
  threadId: thread.id,
  message: 'How do I authenticate?',
  useRAG: true,
});

console.log(response.metadata);
// {
//   count: 3,
//   totalChunks: 45,
//   strategy: 'markdown',
//   avgScore: 0.82,
//   sources: [
//     { id: 'auth-chunk-1', section: 'Authentication', type: 'text', score: 0.91 },
//     { id: 'auth-chunk-2', section: 'Authentication', type: 'code', score: 0.85 },
//     ...
//   ]
// }
```

## API Reference

### `DocsRAGPlugin`

#### Constructor
```typescript
new DocsRAGPlugin(config: DocsRAGConfig)
```

#### Methods

| Method | Description |
|--------|-------------|
| `retrieveContext(message, options)` | Search documentation |
| `ingest(documents, options)` | Index documents |
| `update(id, document, options)` | Update a document |
| `delete(ids, options)` | Remove documents |
| `getStats()` | Get indexing statistics |
| `getCacheStats()` | Get embedding cache stats |
| `clearCache()` | Clear embedding cache |
| `clearAgent(agentId)` | Clear agent's data |
| `clearAll()` | Clear all tenant data |
| `disconnect()` | Close MongoDB connection |

## Use Cases

- **API Documentation** - Search endpoints, parameters, examples
- **User Guides** - Natural language queries over tutorials
- **Knowledge Bases** - Company wikis and internal docs
- **Code References** - Search code examples and snippets
- **FAQs** - Question-answer retrieval

## Additional Documentation

### Getting Started
- 🚀 **[QUICKSTART.md](./QUICKSTART.md)** - Complete setup from scratch (first time)

### Setup & Configuration
- 📘 **[Atlas Setup Guide](./docs/ATLAS_SETUP_GUIDE.md)** - Visual step-by-step guide to create the vector search index
- 🔧 **[Troubleshooting Guide](./docs/TROUBLESHOOTING.md)** - Solutions to common problems

### Scripts & Examples

Examples are in the monorepo:
- 📁 **[sdk/examples/docs-rag/](../../../sdk/examples/docs-rag/)** - Complete usage examples
- ✅ **[verify-index.ts](../../../sdk/examples/docs-rag/verify-index.ts)** - Verify MongoDB configuration
- 🧪 **[test-plugin.ts](../../../sdk/examples/docs-rag/test-plugin.ts)** - Full test with ingestion and search
- 📄 **[ingest-pdf.ts](../../../sdk/examples/docs-rag/ingest-pdf.ts)** - PDF ingestion example
- 📄 **[ingest-docx.ts](../../../sdk/examples/docs-rag/ingest-docx.ts)** - DOCX ingestion example
- 🌐 **[ingest-html.ts](../../../sdk/examples/docs-rag/ingest-html.ts)** - HTML ingestion example
- 💻 **[ingest-code.ts](../../../sdk/examples/docs-rag/ingest-code.ts)** - Source code ingestion example

### Quick Commands
```bash
# Verify configuration
cd sdk/examples/docs-rag
npx tsx verify-index.ts

# Test complete plugin
npx tsx test-plugin.ts
```

## License

MIT © ViloTech

## Support

- [ViloTech]("https://vilotech.co")
- [SnapAgent SDK](https://github.com/vilotech/snap-agent)
- [Documentation](../../sdk/README.md)
- [GitHub Issues](https://github.com/vilotech/snap-agent/issues)