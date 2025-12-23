# @snap-agent/rag-docs

Documentation RAG plugin for SnapAgent SDK - Semantic search over markdown, code, and technical documentation.

## Features

- **Smart Chunking** - Markdown-aware, paragraph, sentence, or fixed-size strategies
- **Code-Aware** - Extracts and indexes code blocks with language detection
- **Section Hierarchy** - Preserves heading structure for context
- **Semantic Search** - OpenAI embeddings for natural language queries
- **In-Memory** - Fast, zero-config storage
- **Similarity Filtering** - Configurable minimum score threshold  

## Installation

```bash
npm install @snap-agent/rag-docs @snap-agent/core
```

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
  // Required
  embeddingProviderApiKey: process.env.OPENAI_API_KEY!,

  // Chunking
  chunkingStrategy: 'markdown', // 'markdown' | 'paragraph' | 'sentence' | 'fixed'
  maxChunkSize: 1000,           // Max characters per chunk
  chunkOverlap: 200,            // Overlap for fixed strategy

  // Search
  limit: 5,                     // Results to return
  minSimilarity: 0.7,           // Minimum similarity score (0-1)

  // Options
  includeCode: true,            // Index code blocks
  embeddingModel: 'text-embedding-3-small',
});
```

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
| `clearAgent(agentId)` | Clear agent's data |
| `clearAll()` | Clear all data |

## Use Cases

- **API Documentation** - Search endpoints, parameters, examples
- **User Guides** - Natural language queries over tutorials
- **Knowledge Bases** - Company wikis and internal docs
- **Code References** - Search code examples and snippets
- **FAQs** - Question-answer retrieval

## License

MIT © ViloTech

