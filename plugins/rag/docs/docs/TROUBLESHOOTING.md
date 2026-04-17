# MongoDB Atlas Vector Search - Troubleshooting

## Common Problems and Solutions

### 1. "Index not found" or "No results found"

**Symptoms:**
- `retrieveContext()` returns 0 results
- Error: `index "docs_vector_index" not found`

**Causes and Solutions:**

#### A. The index does not exist
```bash
# Verify with the script
pnpm verify-index
```

**Solution:** Create the index following the steps in the README.

#### B. The index status is "Building"
- Go to Atlas UI → Atlas Search
- Verify that the status is **"Active"** (not "Building" or "Initial Sync")
- Wait 2-5 minutes until it completes

#### C. Incorrect index name
```typescript
// Verify it matches the name in Atlas
const plugin = new DocsRAGPlugin({
  vectorIndexName: 'docs_vector_index', // ⚠️ Must match exactly
  // ...
});
```

#### D. No documents ingested
```typescript
// First ingest documents
await plugin.ingest([docs], { agentId: 'test-agent' });

// Then wait a few seconds for indexing
await new Promise(r => setTimeout(r, 2000));

// Now search
await plugin.retrieveContext(query, { agentId: 'test-agent' });
```

---

### 2. "numDimensions mismatch"

**Error:**
```
Vector search error: embedding dimension mismatch
```

**Cause:** The embedding dimensions do not match the index.

**Solution:**

| Model | Dimensions |
|-------|------------|
| `text-embedding-3-small` | 1536 |
| `text-embedding-3-large` | 3072 |
| `text-embedding-ada-002` | 1536 |
| `voyage-3-lite` | 1024 |
| `voyage-3` | 1024 |

Update the index in Atlas:
```json
{
  "type": "vector",
  "path": "embedding",
  "numDimensions": 1536,  // ⚠️ Change according to your model
  "similarity": "cosine"
}
```

---

### 3. "Free Tier / M0 not supported"

**Error:**
```
Vector Search is not available on free tier (M0/M2/M5)
```

**Cause:** Vector Search requires Atlas M10 or higher.

**Solution:**
1. Upgrade your cluster to **M10** or higher
2. In Atlas: Cluster → Edit Configuration → General → Cluster Tier → M10

**Approximate costs (US East):**
- M10: ~$0.08/hour (~$57/month)
- M20: ~$0.20/hour (~$144/month)

**Development alternative:**
- Use the Atlas free trial (free credits)
- Shared M10+ during development, downgrade afterwards

---

### 4. "Connection timeout" or "Network error"

**Symptoms:**
- `MongoServerError: connection timeout`
- `ECONNREFUSED` or `ETIMEDOUT`

**Solutions:**

#### A. Whitelist IP
1. Go to Atlas → Network Access → IP Access List
2. Click "Add IP Address"
3. Options:
   - Development: "Allow Access from Anywhere" (0.0.0.0/0)
   - Production: Your specific IP only

#### B. Incorrect Connection String
```typescript
// ✅ Correct (with credentials and database)
mongodb+srv://username:password@cluster.mongodb.net/mydb?retryWrites=true&w=majority

// ❌ Incorrect
mongodb://localhost:27017 // Does not work with Atlas
```

#### C. Corporate firewall
- Verify that port 27017 is open
- Try with a VPN or different network

---

### 5. "Embedding API rate limit"

**Error:**
```
OpenAI API error: 429 - Rate limit exceeded
```

**Solution:**

#### A. Enable caching
```typescript
const plugin = new DocsRAGPlugin({
  cache: {
    embeddings: {
      enabled: true,      // ✅ Reduce API calls
      ttl: 3600000,       // 1 hour
      maxSize: 1000,
    },
  },
});
```

#### B. Batch ingestion with delay
```typescript
// Ingest in small batches
const batchSize = 10;
for (let i = 0; i < docs.length; i += batchSize) {
  const batch = docs.slice(i, i + batchSize);
  await plugin.ingest(batch, { agentId: 'test' });
  
  // Delay between batches
  if (i + batchSize < docs.length) {
    await new Promise(r => setTimeout(r, 1000));
  }
}
```

#### C. Upgrade OpenAI tier
- Tier 1: 500 requests/min
- Tier 2: 5,000 requests/min
- Tier 3+: Higher limits

---

### 6. Query returns irrelevant results

**Symptoms:**
- Returned chunks are not relevant
- Very low score (< 0.7)

**Solutions:**

#### A. Adjust minSimilarity
```typescript
const plugin = new DocsRAGPlugin({
  minSimilarity: 0.65,  // Lower for more results (default: 0.7)
  limit: 10,            // Increase result limit
});
```

#### B. Review the chunking strategy
```typescript
// For technical docs
chunkingStrategy: 'markdown',  // ✅ Better for structured docs

// For long unstructured text
chunkingStrategy: 'paragraph',

// Adjust chunk size
maxChunkSize: 1500,  // Larger = more context, less precision
```

#### C. Use filters
```typescript
await plugin.retrieveContext(query, {
  agentId: 'test',
  filters: {
    type: 'text',        // Text chunks only (no code)
    section: 'API',      // Specific section only
  },
});
```

---

### 7. "Too many chunks" / Performance issues

**Symptoms:**
- Ingestion is very slow
- Queries take too long
- Too many chunks in the database

**Solutions:**

#### A. Increase chunk size
```typescript
const plugin = new DocsRAGPlugin({
  maxChunkSize: 2000,      // Increase from 1000 to 2000
  chunkOverlap: 100,       // Reduce overlap
});
```

#### B. Filter content before ingesting
```typescript
// Don't ingest the entire document
const cleanContent = content
  .replace(/<!--[\s\S]*?-->/g, '')  // Remove HTML comments
  .replace(/^```[\s\S]*?```$/gm, '')  // Remove code blocks if not needed
  .trim();
```

#### C. Use agent-specific content
```typescript
// Shared content (available to all)
await plugin.ingest(sharedDocs, { agentId: 'shared' });

// Agent-specific content
await plugin.ingest(agentSpecificDocs, { agentId: 'sales-agent' });
```

---

### 8. "Duplicate documents" / Re-indexing

**Problem:** Re-ingesting the same document creates duplicate chunks.

**Solution:**

#### A. Use update instead of ingest
```typescript
// ❌ Don't do this (creates duplicates)
await plugin.ingest([doc], { agentId: 'test' });
await plugin.ingest([doc], { agentId: 'test' });  // Creates duplicates

// ✅ Do this instead
await plugin.update(doc.id, doc, { agentId: 'test' });  // Replaces
```

#### B. Clean up before re-ingesting
```typescript
// Option 1: Clean specific document
await plugin.delete('doc-id', { agentId: 'test' });
await plugin.ingest([newDoc], { agentId: 'test' });

// Option 2: Clean all agent data
await plugin.clearAgent('test');
await plugin.ingest(allDocs, { agentId: 'test' });
```

---

## Diagnostic Scripts

### Verify connection and configuration
```bash
pnpm verify-index
```

### Full test
```bash
pnpm test-plugin
```

### Inspect documents in MongoDB

```typescript
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI!);
await client.connect();

const coll = client.db('my_docs').collection('docs_content');

// View all chunks
const chunks = await coll.find({}).limit(10).toArray();
console.log(chunks);

// Count by type
const byType = await coll.aggregate([
  { $group: { _id: '$metadata.type', count: { $sum: 1 } } }
]).toArray();
console.log(byType);
```

---

## Useful Resources

- [MongoDB Atlas Vector Search Docs](https://www.mongodb.com/docs/atlas/atlas-vector-search/)
- [OpenAI Embeddings Guide](https://platform.openai.com/docs/guides/embeddings)
- [Atlas Search Index Syntax](https://www.mongodb.com/docs/atlas/atlas-search/create-index/)

---

## Need more help?

1. Check [GitHub Issues](https://github.com/vilotech/snap-agent/issues)
2. Review the MongoDB logs in Atlas UI → Metrics
3. Enable debug logging in your app
