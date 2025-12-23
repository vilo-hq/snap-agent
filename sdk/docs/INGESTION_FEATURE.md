# RAG Plugin Ingestion Feature

## Overview

The SnapAgent SDK supports optional ingestion capabilities for RAG plugins, enabling dynamic data management directly through the SDK. This feature allows plugins to provide their own indexing logic while maintaining a consistent API.


### 1. Plugin Interface Extensions

**File:** `../src/types/plugins.ts`

Optional ingestion methods in the `RAGPlugin` interface:

- `ingest(documents, options)` - Bulk document ingestion with embeddings
- `update(id, document, options)` - Update single document
- `delete(ids, options)` - Delete document(s)
- `bulk(operations, options)` - Batch operations (insert/update/delete)

**Types:**
- `RAGDocument` - Standard document format for ingestion
- `IngestResult` - Result of ingestion operations
- `IngestOptions` - Configuration for ingestion
- `BulkOperation` - Operation descriptor for bulk actions
- `BulkResult` - Result of bulk operations

### 2. Agent Helper Methods

**File:** `../src/core/Agent.ts`

`Agent` class methods for convenience:

```typescript
await agent.ingestDocuments(documents, options);
await agent.updateDocument(id, document, options);
await agent.deleteDocuments(ids, options);
await agent.bulkDocumentOperations(operations, options);
```

These methods automatically:
- Route to all RAG plugins that support ingestion
- Include agent ID in options
- Aggregate results from multiple plugins
- Provide clear error messages

### 3. EcommerceRAGPlugin Implementation

**File:** `../../plugins/rag-ecommerce/src/EcommerceRAGPlugin.ts`

**Features:**
- Batch embedding generation with caching
- Flexible insert modes (overwrite, skip existing, upsert)
- Partial document updates
- Bulk delete operations
- Comprehensive error handling
- MongoDB bulk write optimization

**Processing Flow:**
1. Convert `RAGDocument` to `ProductDoc` format
2. Generate embeddings using Voyage AI (with caching)
3. Index with MongoDB (respects tenant/agent isolation)
4. Return detailed results (success counts, errors)

### 4. Example Implementation

**File:** `../examples/product-ingestion.ts`

Comprehensive example demonstrating:
- Bulk product ingestion (3 products)
- Single product update (price/metrics)
- Bulk operations (insert + update)
- Search verification after ingestion
- Product deletion
- Error handling

## Usage Examples

### Basic Ingestion

```typescript
import { createClient } from '@snap-agent/core';
import { EcommerceRAGPlugin } from '@snap-agent/rag-ecommerce';

// Initialize plugin with ingestion support
const ragPlugin = new EcommerceRAGPlugin({
  mongoUri: process.env.MONGODB_URI,
  openaiApiKey: process.env.OPENAI_API_KEY,
  voyageApiKey: process.env.VOYAGE_API_KEY,
  tenantId: 'my-store',
});

// Create agent with plugin
const agent = await client.createAgent({
  name: 'Shopping Assistant',
  plugins: [ragPlugin],
  // ...
});

// Ingest products
const products = [
  {
    id: 'PROD-001',
    content: 'Modern black leather jacket...',
    metadata: {
      title: 'Leather Jacket',
      category: 'Jackets',
      price: 299.99,
      brand: 'UrbanStyle',
      color: 'Black',
      // ...
    }
  }
];

const results = await agent.ingestDocuments(products);
console.log(`Indexed: ${results[0].indexed}, Failed: ${results[0].failed}`);
```

### Update Product

```typescript
await agent.updateDocument('PROD-001', {
  metadata: {
    price: 279.99,
    inStock: true,
  }
});
```

### Bulk Operations

```typescript
await agent.bulkDocumentOperations([
  {
    type: 'insert',
    id: 'PROD-002',
    document: { id: 'PROD-002', content: '...', metadata: {...} }
  },
  {
    type: 'update',
    id: 'PROD-001',
    document: { metadata: { price: 259.99 } }
  },
  {
    type: 'delete',
    id: 'PROD-OLD'
  }
]);
```

### Delete Products

```typescript
// Single
await agent.deleteDocuments('PROD-001');

// Multiple
await agent.deleteDocuments(['PROD-001', 'PROD-002', 'PROD-003']);
```

## Key Benefits

### 1. Plugin Autonomy
Each plugin implements its own ingestion logic:
- Custom data formats
- Specific embedding strategies
- Platform-specific optimizations
- Domain-specific validation

### 2. Optional by Design
- Plugins can be read-only (external APIs, static data)
- No breaking changes to existing plugins
- Clear TypeScript types indicate support

### 3. Consistent Interface
- Same API across all plugins
- Predictable error handling
- Standard result formats
- Unified documentation

### 4. Agent-Level Convenience
- Single entry point through Agent class
- Automatic plugin discovery
- Aggregated results
- Simplified error messages

## Performance Considerations

### Embedding Generation
- Cached embeddings reduce API calls (70-80% hit rate)
- Batch processing for efficiency
- Configurable batch sizes

### MongoDB Operations
- Bulk writes for multiple documents
- Upsert support for idempotency
- Tenant/agent isolation via indexes

### Error Handling
- Per-document error tracking
- Partial success support
- Detailed error messages