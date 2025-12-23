# RAG Plugin Caching

The EcommerceRAGPlugin includes built-in intelligent caching to reduce API calls, costs, and latency.

## What Gets Cached

### 1. Embeddings Cache
- **What**: Vector embeddings from Voyage AI
- **Key**: `{model}:{text}`
- **Default TTL**: 1 hour
- **Max Size**: 1000 entries
- **Benefit**: Same queries → instant embeddings (no API call)

### 2. Attribute Extraction Cache
- **What**: Extracted product attributes from OpenAI
- **Key**: Normalized user message
- **Default TTL**: 30 minutes
- **Max Size**: 500 entries
- **Benefit**: Same queries → instant attributes (no OpenAI call)

## Configuration

### Default (Caching Enabled)

```typescript
const plugin = new EcommerceRAGPlugin({
  mongoUri: process.env.MONGODB_URI!,
  openaiApiKey: process.env.OPENAI_API_KEY!,
  voyageApiKey: process.env.VOYAGE_API_KEY!,
  tenantId: 'my-store',
  // Caching is enabled by default!
});
```

### Custom Cache Settings

```typescript
const plugin = new EcommerceRAGPlugin({
  // ... required config
  cache: {
    embeddings: {
      enabled: true,
      ttl: 7200000, // 2 hours
      maxSize: 2000,
    },
    attributes: {
      enabled: true,
      ttl: 3600000, // 1 hour
      maxSize: 1000,
    },
  },
});
```

### Disable Caching

```typescript
const plugin = new EcommerceRAGPlugin({
  // ... required config
  cache: {
    embeddings: { enabled: false },
    attributes: { enabled: false },
  },
});
```

## Monitoring Cache Performance

```typescript
// Get cache statistics
const stats = plugin.getCacheStats();

console.log(stats);
// {
//   embeddings: {
//     size: 450,
//     maxSize: 1000,
//     hits: 1250,
//     misses: 320,
//     hitRate: '0.80'  // 80% hit rate!
//   },
//   attributes: {
//     size: 180,
//     maxSize: 500,
//     hits: 890,
//     misses: 210,
//     hitRate: '0.81'  // 81% hit rate!
//   }
// }
```

## Cache Management

```typescript
// Clear all caches (useful for testing)
plugin.clearCache();

// Caches auto-cleanup every 5 minutes
// Expired entries are automatically removed
```

## Performance Impact

### Without Caching
```
Query: "red sneakers under $100"
├─ Embed query: ~200ms + $0.0001
├─ Extract attributes: ~300ms + $0.0002
├─ Vector search: ~100ms
└─ Total: ~600ms, $0.0003

10,000 queries/day = 6000 seconds, $3.00
```

### With Caching (80% hit rate)
```
Query: "red sneakers under $100" (cached)
├─ Embed query: ~0ms (cache hit!)
├─ Extract attributes: ~0ms (cache hit!)
├─ Vector search: ~100ms
└─ Total: ~100ms, $0.00

10,000 queries/day = 1200 seconds, $0.60
Savings: 80% latency, 80% cost!
```

## When Cache Helps Most

**High Repeat Queries**
- "Show me running shoes" (repeated by multiple users)
- Common product searches
- Seasonal queries

**User Refining Search**
- User asks similar queries in succession
- "red shoes" → "red running shoes" → "red nike shoes"

**High Traffic Applications**
- Multiple users searching similar products
- Popular categories/brands

## When to Adjust Cache Settings

### Increase TTL if:
- Product catalog changes slowly
- Users repeat queries over long periods
- Cost savings are priority

### Decrease TTL if:
- Product inventory changes frequently
- Real-time accuracy is critical
- Product attributes update often

### Increase Max Size if:
- Many unique queries per hour
- High traffic application
- Sufficient memory available

### Disable Caching if:
- Every query must be real-time
- Product data changes constantly
- Memory is extremely constrained

## Cache Invalidation

Caches auto-expire based on TTL. Manual clearing:

```typescript
// Clear all caches
plugin.clearCache();

// Or recreate plugin with fresh cache
const newPlugin = new EcommerceRAGPlugin({ /* config */ });
```

## Best Practices

1. **Monitor Hit Rates**: Aim for 60-80% hit rate
2. **Adjust TTL**: Match your data update frequency
3. **Size Appropriately**: Set maxSize based on query diversity
4. **Log Stats**: Track cache performance in production

```typescript
// Log cache stats periodically
setInterval(() => {
  const stats = plugin.getCacheStats();
  console.log('RAG Cache Stats:', stats);
}, 60000); // Every minute
```

## Memory Usage

Approximate memory per cached entry:
- **Embedding**: ~4KB (1024 dimensions × 4 bytes)
- **Attributes**: ~1KB (small JSON object)

**Default config memory**: ~4.5MB
- 1000 embeddings × 4KB = 4MB
- 500 attributes × 1KB = 0.5MB

## Technical Details

### Cache Eviction Strategy
- **Type**: Simple LRU (Least Recently Used)
- **When**: Cache exceeds maxSize
- **What**: Oldest entry removed

### Expiration
- **Lazy**: Checked on access
- **Eager**: Cleanup every 5 minutes
- **Benefit**: No memory leaks from expired entries

## Example: Production Configuration

```typescript
const plugin = new EcommerceRAGPlugin({
  mongoUri: process.env.MONGODB_URI!,
  openaiApiKey: process.env.OPENAI_API_KEY!,
  voyageApiKey: process.env.VOYAGE_API_KEY!,
  tenantId: 'my-store',
  
  // Optimize for high traffic e-commerce
  cache: {
    embeddings: {
      enabled: true,
      ttl: 3600000, // 1 hour (product catalog stable)
      maxSize: 5000, // High traffic, lots of unique queries
    },
    attributes: {
      enabled: true,
      ttl: 1800000, // 30 min (attributes more volatile)
      maxSize: 2000,
    },
  },
});

// Monitor performance
setInterval(() => {
  const stats = plugin.getCacheStats();
  if (parseFloat(stats.embeddings.hitRate) < 0.5) {
    console.warn('Low embedding cache hit rate. Consider increasing maxSize or TTL');
  }
}, 300000); // Every 5 minutes
```

## Summary

- **Enabled by default** - No configuration needed
- **Significant savings** - 50-80% reduction in latency and costs
- **Zero breaking changes** - Works with existing code
- **Configurable** - Tune for your use case
- **Observable** - Track performance with stats  

The caching layer is a **free performance upgrade** for your RAG plugin!

