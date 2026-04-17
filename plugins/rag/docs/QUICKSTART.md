# 🚀 Quick Setup - DocsRAGPlugin

## Initial Setup (First Time)

### 1. Install Dependencies

```bash
cd plugins/rag/docs
pnpm install
```

This will install:
- ✅ `mongodb` - MongoDB client
- ✅ `openai` - OpenAI client for embeddings
- ✅ `tsx` - To run TypeScript directly
- ✅ `typescript`, `tsup` - Build tools

### 2. Configure Environment Variables

**📁 Location:** The `.env` file should be at:
```
plugins/rag/docs/.env
```

> 📖 **See full structure:** [FILE_STRUCTURE.md](./docs/FILE_STRUCTURE.md)

Create the file by copying the example:

```bash
cd plugins/rag/docs
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# MongoDB Atlas
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=my_docs
MONGODB_COLLECTION=docs_content

# OpenAI
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional
TENANT_ID=my-company
AGENT_ID=test-agent
```

**How to obtain these credentials?**

#### MongoDB URI:
1. Go to [MongoDB Atlas](https://cloud.mongodb.com)
2. Click on your cluster → **"Connect"**
3. Select **"Connect your application"**
4. Copy the connection string
5. Replace `<password>` with your actual password

#### OpenAI API Key:
1. Go to [OpenAI Platform](https://platform.openai.com/api-keys)
2. Click **"+ Create new secret key"**
3. Copy the key (starts with `sk-proj-`)

### 3. Create the Vector Search Index in MongoDB

**Option 1: Full Visual Guide**
📘 Follow step by step: [ATLAS_SETUP_GUIDE.md](./docs/ATLAS_SETUP_GUIDE.md)

**Option 2: Quick Steps**

1. Go to [MongoDB Atlas](https://cloud.mongodb.com)
2. Your Cluster → **"Atlas Search"** (left menu)
3. Click **"Create Search Index"**
4. Select **"Atlas Vector Search"**
5. Configuration:
   - Method: **JSON Editor**
   - Index Name: `docs_vector_index`
   - Database: `my_docs`
   - Collection: `docs_content`
6. Paste this JSON:

```json
{
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
```

7. Click **"Create Search Index"**
8. Wait for the status to be **"Active"** (1-3 minutes)

### 4. Verify Everything Works

```bash
cd ../../../sdk/examples/docs-rag
npx tsx verify-index.ts
```

Expected output:
```
✅ Connected to MongoDB
✅ Collection "docs_content" exists
✅ Index "docs_vector_index" found!
   📊 Status: Active
```

If you see errors, check [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)

### 5. Test the Plugin

```bash
cd ../../../sdk/examples/docs-rag
npx tsx test-plugin.ts
```

This will:
1. Ingest a test document
2. Perform semantic searches
3. Show statistics
4. Verify persistence

Expected output:
```
✅ Document ingested: 1 document(s)

🔍 Query: "How do I authenticate?"
   📊 Results: 2
   📈 Average score: 0.847

✅ Test completed successfully!
```

---

## Available Scripts

| Command | Description | Location |
|---------|-------------|----------|
| `pnpm build` | Build the plugin to dist/ | `plugins/rag/docs/` |
| `pnpm dev` | Build in watch mode | `plugins/rag/docs/` |
| `pnpm test` | Run unit tests | `plugins/rag/docs/` |
| `npx tsx verify-index.ts` | Verify MongoDB | `sdk/examples/docs-rag/` |
| `npx tsx test-plugin.ts` | Full plugin test | `sdk/examples/docs-rag/` |

---

## Usage in Your Application

Once configured, use it like this:

```typescript
import { DocsRAGPlugin } from '@snap-agent/rag-docs';
import { createClient, MemoryStorage } from '@snap-agent/core';

const client = createClient({
  storage: new MemoryStorage(),
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
  },
});

const agent = await client.createAgent({
  name: 'Docs Assistant',
  instructions: 'Help users find information in documentation.',
  model: 'gpt-4o',
  userId: 'user-123',
  plugins: [
    new DocsRAGPlugin({
      // MongoDB
      mongoUri: process.env.MONGODB_URI!,
      dbName: 'my_docs',
      tenantId: 'my-company',
      
      // Embeddings
      embeddingProviderApiKey: process.env.OPENAI_API_KEY!,
      chunkingStrategy: 'markdown',
      
      // Cache (optional but recommended)
      cache: {
        embeddings: {
          enabled: true,
          ttl: 3600000,
          maxSize: 1000,
        },
      },
    }),
  ],
});

// Ingest documents
await agent.ingestDocuments([
  {
    id: 'getting-started',
    content: '# Getting Started\n\n...',
    metadata: { title: 'Getting Started' },
  },
]);

// Ask questions
const response = await client.chat({
  threadId: thread.id,
  message: 'How do I get started?',
  useRAG: true,
});

console.log(response.text);
```

---

## ⚠️ Requirements

### MongoDB Atlas Tier
- ❌ **M0/M2/M5** (Free) - Do NOT support Vector Search
- ✅ **M10+** - Required (~$0.08/hour)

To upgrade: Atlas → Cluster → Edit Configuration → M10

### Node.js
- Version 18+ recommended

### IP Whitelist
To connect to Atlas from your machine:
1. Atlas → **Network Access**
2. **Add IP Address**
3. Development: "Allow Access from Anywhere" (0.0.0.0/0)

---

## 📚 More Resources

- 📘 [ATLAS_SETUP_GUIDE.md](./docs/ATLAS_SETUP_GUIDE.md) - Detailed visual guide
- 🔧 [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) - Solutions to common problems
- 📖 [README.md](./README.md) - Full API documentation

---

## 🆘 Problems?

### "tsx is not recognized as a command"
```bash
# Make sure to install dependencies first
pnpm install
```

### "Cannot find module '@snap-agent/core'"
```bash
# Install peer dependencies
cd ../../../  # Go to workspace root
pnpm install
```

### "MongoServerError: connection timeout"
- Verify your IP is whitelisted (Network Access in Atlas)
- Verify the MONGODB_URI is correct

### More help
See [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)
