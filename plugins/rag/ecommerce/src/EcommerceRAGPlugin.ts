// Note: In production, this will import from the published package
// For development, TypeScript may show an error - this is expected
import type {
  RAGPlugin,
  RAGContext,
  RAGDocument,
  IngestResult,
  IngestOptions,
  BulkOperation,
  BulkResult,
} from '@snap-agent/core';
import { MongoClient, Db, Collection } from 'mongodb';
import OpenAI from 'openai';

// ============================================================================
// URL Ingestion Types (local definitions)
// ============================================================================

export interface URLSource {
  url: string;
  type: 'json' | 'csv' | 'xml' | 'api';
  auth?: {
    type: 'bearer' | 'basic' | 'api-key' | 'custom';
    token?: string;
    username?: string;
    password?: string;
    header?: string;
    key?: string;
    headers?: Record<string, string>;
  };
  transform?: {
    documentPath?: string;
    fieldMapping?: {
      id?: string;
      content?: string;
      [key: string]: string | undefined;
    };
  };
  headers?: Record<string, string>;
  timeout?: number;
  metadata?: Record<string, any>;
}

export interface URLIngestResult extends IngestResult {
  sourceUrl: string;
  fetchedAt: Date;
  documentsFetched: number;
}

// ============================================================================
// Types
// ============================================================================

export interface EcommerceRAGConfig {
  // Connection
  mongoUri: string;
  dbName?: string;
  collection?: string;

  // OpenAI for attribute extraction
  openaiApiKey: string;

  // Embeddings
  voyageApiKey: string;
  embeddingModel?: string;

  // Tenant/Agent filtering
  tenantId: string;
  // Note: Products can be shared (no agentId) or agent-specific (with agentId)
  // - Ingest WITHOUT agentId → Product available to ALL agents in tenant
  // - Ingest WITH agentId → Product only available to that specific agent
  // - Query WITH agentId → Returns shared products + agent-specific products

  // Attribute extraction
  attributeList?: string[];
  enableAttributeExtraction?: boolean;

  // Search configuration
  numCandidates?: number;
  limit?: number;
  vectorIndexName?: string;

  // Rescoring weights
  rescoringWeights?: {
    color?: number;
    size?: number;
    material?: number;
    category?: number;
    brand?: number;
    popularity?: number;
    ctr?: number;
    sales?: number;
  };

  // Reranking
  enableReranking?: boolean;
  rerankTopK?: number;

  // Context formatting
  contextProductCount?: number;
  language?: 'es' | 'en';
  includeOutOfStock?: boolean;

  // Caching configuration
  cache?: {
    embeddings?: {
      enabled?: boolean;
      ttl?: number; // TTL in milliseconds (default: 1 hour)
      maxSize?: number; // Max cache entries (default: 1000)
    };
    attributes?: {
      enabled?: boolean;
      ttl?: number; // TTL in milliseconds (default: 30 minutes)
      maxSize?: number; // Max cache entries (default: 500)
    };
  };

  // Plugin config
  priority?: number;
}

export interface ProductDoc {
  _id?: any;
  tenantId: string;
  agentId?: string;
  sku: string;
  title: string;
  description?: string;
  embedding: number[];
  attributes: {
    category?: string;
    brand?: string;
    color?: string;
    material?: string;
    size?: string[];
    gender?: 'M' | 'F' | 'Unisex';
    season?: string;
    price?: number;
    [key: string]: any;
  };
  inStock?: boolean;
  metrics?: {
    popularity?: number;
    ctr?: number;
    sales?: number;
  };
  vectorSearchScore?: number;
}

export interface QueryAttrs {
  category?: string;
  color?: string;
  gender?: string;
  brand?: string;
  material?: string;
  size?: string;
  season?: string;
  priceMin?: number;
  priceMax?: number;
  [key: string]: any;
}

// ============================================================================
// Cache Entry Types
// ============================================================================

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

// ============================================================================
// Ecommerce RAG Plugin
// ============================================================================

export class EcommerceRAGPlugin implements RAGPlugin {
  name = 'ecommerce-rag';
  type = 'rag' as const;
  priority: number;

  private config: Required<EcommerceRAGConfig>;
  private client: MongoClient;
  private db: Db | null = null;
  private openai: OpenAI;

  // Caching layers
  private embeddingCache: Map<string, CacheEntry<number[]>> = new Map();
  private attributeCache: Map<string, CacheEntry<QueryAttrs>> = new Map();

  // Cache statistics
  private cacheStats = {
    embeddings: { hits: 0, misses: 0 },
    attributes: { hits: 0, misses: 0 },
  };

  // Cleanup interval reference
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(config: EcommerceRAGConfig) {
    // Set defaults
    this.config = {
      dbName: 'agentStudio',
      collection: 'products',
      embeddingModel: 'voyage-multilingual-2',
      attributeList: [
        'category',
        'color',
        'gender',
        'brand',
        'material',
        'size',
        'season',
        'priceMin',
        'priceMax',
      ],
      enableAttributeExtraction: true,
      numCandidates: 200,
      limit: 50,
      vectorIndexName: 'product_vector_index',
      rescoringWeights: {
        color: 0.15,
        size: 0.10,
        material: 0.10,
        category: 0.12,
        brand: 0.08,
        popularity: 0.05,
        ctr: 0.10,
        sales: 0.10,
      },
      enableReranking: false,
      rerankTopK: 10,
      contextProductCount: 8,
      language: 'es',
      includeOutOfStock: false,
      priority: 10,
      ...config,
      cache: {
        embeddings: {
          enabled: config.cache?.embeddings?.enabled ?? true,
          ttl: config.cache?.embeddings?.ttl ?? 3600000, // 1 hour
          maxSize: config.cache?.embeddings?.maxSize ?? 1000,
        },
        attributes: {
          enabled: config.cache?.attributes?.enabled ?? true,
          ttl: config.cache?.attributes?.ttl ?? 1800000, // 30 minutes
          maxSize: config.cache?.attributes?.maxSize ?? 500,
        },
      },
    };

    this.priority = this.config.priority;
    this.client = new MongoClient(this.config.mongoUri);
    this.openai = new OpenAI({ apiKey: this.config.openaiApiKey });

    // Start cache cleanup interval (every 5 minutes)
    this.startCacheCleanup();
  }

  private async ensureConnection(): Promise<Db> {
    if (!this.db) {
      await this.client.connect();
      this.db = this.client.db(this.config.dbName);
    }
    return this.db;
  }

  /**
   * Main retrieval method - called by the SDK
   */
  async retrieveContext(
    message: string,
    options: {
      agentId: string;
      threadId?: string;
      filters?: Record<string, any>;
      metadata?: Record<string, any>;
    }
  ): Promise<RAGContext> {
    // 1. Embed the query
    const queryVector = await this.embedText(message);

    // 2. Extract attributes (if enabled)
    let attributes: QueryAttrs = {};
    if (this.config.enableAttributeExtraction) {
      attributes = await this.extractAttributes(message);
    }

    // 3. Vector search with hard filters
    const searchResults = await this.vectorSearch({
      queryVector,
      agentId: options.agentId,
      hardFilters: options.filters || {},
    });

    // 4. Soft rescore based on attributes
    const rescored = this.softRescore(searchResults, attributes);

    // 5. Optional reranking
    let final = rescored;
    if (this.config.enableReranking) {
      final = await this.rerank(message, rescored);
    }

    // 6. Filter out of stock (if configured)
    if (!this.config.includeOutOfStock) {
      final = final.filter((p) => p.inStock !== false);
    }

    // 7. Return RAG context
    return {
      content: this.buildContextString(final),
      sources: final.slice(0, this.config.contextProductCount).map((p) => ({
        id: p.sku,
        title: p.title,
        score: p.vectorSearchScore,
        type: 'product',
        attributes: p.attributes,
        inStock: p.inStock,
      })),
      metadata: {
        productCount: final.length,
        extractedAttributes: attributes,
        topProducts: final.slice(0, 3).map((p) => ({
          sku: p.sku,
          title: p.title,
          score: p.vectorSearchScore,
        })),
      },
    };
  }

  /**
   * Format context for LLM
   */
  formatContext(context: RAGContext): string {
    return context.content;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Embed text using Voyage with caching
   */
  private async embedText(text: string): Promise<number[]> {
    // Check cache if enabled
    if (this.config.cache?.embeddings?.enabled) {
      const cacheKey = `${this.config.embeddingModel}:${text}`;
      const cached = this.embeddingCache.get(cacheKey);

      if (cached) {
        const age = Date.now() - cached.timestamp;
        if (age < (this.config.cache?.embeddings?.ttl ?? 3600000)) {
          this.cacheStats.embeddings.hits++;
          return cached.value;
        } else {
          // Expired, remove from cache
          this.embeddingCache.delete(cacheKey);
        }
      }

      this.cacheStats.embeddings.misses++;
    }

    // Fetch from API
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.voyageApiKey}`,
      },
      body: JSON.stringify({
        input: text,
        model: this.config.embeddingModel,
      }),
    });

    if (!response.ok) {
      throw new Error(`Voyage API error: ${response.statusText}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    const embedding = data.data[0].embedding;

    // Store in cache if enabled
    if (this.config.cache?.embeddings?.enabled) {
      const cacheKey = `${this.config.embeddingModel}:${text}`;
      const maxSize = this.config.cache?.embeddings?.maxSize ?? 1000;

      // Check cache size limit
      if (this.embeddingCache.size >= maxSize) {
        // Remove oldest entry (simple LRU)
        const firstKey = this.embeddingCache.keys().next().value;
        if (firstKey) {
          this.embeddingCache.delete(firstKey);
        }
      }

      this.embeddingCache.set(cacheKey, {
        value: embedding,
        timestamp: Date.now(),
      });
    }

    return embedding;
  }

  /**
   * Extract attributes from user message using OpenAI with caching
   */
  private async extractAttributes(message: string): Promise<QueryAttrs> {
    // Check cache if enabled
    if (this.config.cache?.attributes?.enabled) {
      const cacheKey = message.toLowerCase().trim();
      const cached = this.attributeCache.get(cacheKey);

      if (cached) {
        const age = Date.now() - cached.timestamp;
        if (age < (this.config.cache?.attributes?.ttl ?? 1800000)) {
          this.cacheStats.attributes.hits++;
          return cached.value;
        } else {
          // Expired, remove from cache
          this.attributeCache.delete(cacheKey);
        }
      }

      this.cacheStats.attributes.misses++;
    }

    // Extract via OpenAI
    let attrs: QueryAttrs = {};

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Extract product attributes from the user message. Return a JSON object with only the attributes you can identify from this list: ${this.config.attributeList.join(', ')}. If an attribute is not mentioned, omit it from the response.`,
          },
          {
            role: 'user',
            content: message,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      });

      const extracted = JSON.parse(completion.choices[0]?.message?.content || '{}');

      // Map to QueryAttrs
      if (extracted.category) attrs.category = String(extracted.category);
      if (extracted.color) attrs.color = String(extracted.color);
      if (extracted.gender) {
        const g = String(extracted.gender).toLowerCase();
        if (g.includes('hombre') || g.includes('male') || g.includes('man') || g === 'm') {
          attrs.gender = 'M';
        } else if (
          g.includes('mujer') ||
          g.includes('female') ||
          g.includes('woman') ||
          g === 'f'
        ) {
          attrs.gender = 'F';
        } else if (g.includes('unisex')) {
          attrs.gender = 'Unisex';
        }
      }
      if (extracted.brand) attrs.brand = String(extracted.brand);
      if (extracted.material) attrs.material = String(extracted.material);
      if (extracted.size) attrs.size = String(extracted.size);
      if (extracted.season) attrs.season = String(extracted.season);
      if (extracted.priceMin) attrs.priceMin = Number(extracted.priceMin);
      if (extracted.priceMax) attrs.priceMax = Number(extracted.priceMax);
    } catch (error) {
      console.error('Attribute extraction failed:', error);
      return {};
    }

    // Store in cache if enabled
    if (this.config.cache?.attributes?.enabled) {
      const cacheKey = message.toLowerCase().trim();
      const maxSize = this.config.cache?.attributes?.maxSize ?? 500;

      // Check cache size limit
      if (this.attributeCache.size >= maxSize) {
        // Remove oldest entry (simple LRU)
        const firstKey = this.attributeCache.keys().next().value;
        if (firstKey) {
          this.attributeCache.delete(firstKey);
        }
      }

      this.attributeCache.set(cacheKey, {
        value: attrs,
        timestamp: Date.now(),
      });
    }

    return attrs;
  }

  /**
   * MongoDB Atlas Vector Search
   */
  private async vectorSearch(options: {
    queryVector: number[];
    agentId: string;
    hardFilters: Record<string, any>;
  }): Promise<ProductDoc[]> {
    const db = await this.ensureConnection();
    const collection: Collection<ProductDoc> = db.collection(this.config.collection);

    // Build filter - supports shared products (no agentId) + agent-specific products
    const filter: any = { tenantId: this.config.tenantId };
    if (options.agentId) {
      // Return shared products (no agentId) OR products for this specific agent
      filter.$or = [
        { agentId: { $exists: false } },
        { agentId: null },
        { agentId: options.agentId }
      ];
    }

    // Add hard filters
    Object.entries(options.hardFilters).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        filter[key] = value;
      }
    });

    // Vector search pipeline
    const pipeline = [
      {
        $vectorSearch: {
          index: this.config.vectorIndexName,
          path: 'embedding',
          queryVector: options.queryVector,
          numCandidates: this.config.numCandidates,
          limit: this.config.limit,
          filter,
        },
      },
      {
        $addFields: {
          vectorSearchScore: { $meta: 'vectorSearchScore' },
        },
      },
    ];

    const results = await collection.aggregate(pipeline).toArray();
    return results as ProductDoc[];
  }

  /**
   * Soft rescore based on attributes and metrics
   */
  private softRescore(results: ProductDoc[], attrs: QueryAttrs): ProductDoc[] {
    const weights = this.config.rescoringWeights;

    return results
      .map((product) => {
        let boost = product.vectorSearchScore || 0;

        // Color match
        if (attrs.color && product.attributes.color) {
          const match = product.attributes.color.toLowerCase() === attrs.color.toLowerCase();
          if (match) boost += weights.color!;
        }

        // Size match
        if (attrs.size && product.attributes.size) {
          const match = product.attributes.size.some(
            (s) => s.toLowerCase() === attrs.size?.toLowerCase()
          );
          if (match) boost += weights.size!;
        }

        // Material match
        if (attrs.material && product.attributes.material) {
          const match =
            product.attributes.material.toLowerCase() === attrs.material.toLowerCase();
          if (match) boost += weights.material!;
        }

        // Category match
        if (attrs.category && product.attributes.category) {
          const match =
            product.attributes.category.toLowerCase() === attrs.category.toLowerCase();
          if (match) boost += weights.category!;
        }

        // Brand match
        if (attrs.brand && product.attributes.brand) {
          const match = product.attributes.brand.toLowerCase() === attrs.brand.toLowerCase();
          if (match) boost += weights.brand!;
        }

        // Price proximity
        if (attrs.priceMax && product.attributes.price) {
          const withinBudget = product.attributes.price <= attrs.priceMax;
          if (withinBudget) {
            const proximity = 1 - product.attributes.price / attrs.priceMax;
            boost += Math.max(0, proximity * 0.1);
          }
        }

        // Metrics boosts
        if (product.metrics?.popularity) {
          boost += Math.min(product.metrics.popularity * weights.popularity!, 0.2);
        }
        if (product.metrics?.ctr) {
          boost += Math.min(product.metrics.ctr * weights.ctr!, 0.15);
        }
        if (product.metrics?.sales) {
          const normalizedSales = Math.log10(product.metrics.sales + 1) / 10;
          boost += Math.min(normalizedSales * weights.sales!, 0.1);
        }

        return { ...product, vectorSearchScore: boost };
      })
      .sort((a, b) => (b.vectorSearchScore || 0) - (a.vectorSearchScore || 0));
  }

  /**
   * Optional Voyage reranking
   */
  private async rerank(query: string, products: ProductDoc[]): Promise<ProductDoc[]> {
    if (products.length === 0) return products;

    try {
      const docTexts = products.map(
        (p) =>
          `${p.title}. ${p.description || ''}. ${Object.entries(p.attributes)
            .filter(([_, v]) => v)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')}`
      );

      const response = await fetch('https://api.voyageai.com/v1/rerank', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.voyageApiKey}`,
        },
        body: JSON.stringify({
          query,
          documents: docTexts,
          model: 'rerank-2',
          top_k: this.config.rerankTopK,
        }),
      });

      if (!response.ok) {
        throw new Error(`Voyage rerank error: ${response.statusText}`);
      }

      const data = await response.json() as { data: Array<{ relevance_score: number }> };
      const scores = data.data.map((item) => item.relevance_score);

      const reranked = products.map((doc, idx) => ({
        ...doc,
        vectorSearchScore: (doc.vectorSearchScore || 0) * 0.5 + (scores[idx] || 0) * 0.5,
      }));

      return reranked
        .sort((a, b) => (b.vectorSearchScore || 0) - (a.vectorSearchScore || 0))
        .slice(0, this.config.rerankTopK);
    } catch (error) {
      console.error('Reranking failed:', error);
      return products;
    }
  }

  /**
   * Build context string for LLM
   */
  private buildContextString(products: ProductDoc[]): string {
    const limited = products.slice(0, this.config.contextProductCount);

    if (limited.length === 0) {
      return this.config.language === 'es'
        ? 'No se encontraron productos en el catálogo.'
        : 'No products found in the catalog.';
    }

    const productBlocks = limited.map((product, idx) => {
      const attrs: string[] = [];

      if (product.attributes.category) attrs.push(`Category: ${product.attributes.category}`);
      if (product.attributes.brand) attrs.push(`Brand: ${product.attributes.brand}`);
      if (product.attributes.color) attrs.push(`Color: ${product.attributes.color}`);
      if (product.attributes.material) attrs.push(`Material: ${product.attributes.material}`);
      if (product.attributes.size?.length) {
        attrs.push(`Sizes: ${product.attributes.size.join(', ')}`);
      }
      if (product.attributes.price !== undefined) {
        attrs.push(`Price: $${product.attributes.price.toFixed(2)}`);
      }
      if (product.inStock !== undefined) {
        attrs.push(product.inStock ? 'In Stock' : 'Out of Stock');
      }

      return `${idx + 1}. ${product.title}\n   SKU: ${product.sku}\n   ${product.description || ''
        }\n   ${attrs.join(' | ')}`;
    });

    const header =
      this.config.language === 'es'
        ? 'PRODUCTOS DISPONIBLES EN EL CATÁLOGO:'
        : 'AVAILABLE PRODUCTS IN CATALOG:';

    return `${header}\n\n${productBlocks.join('\n\n')}`;
  }

  // ============================================================================
  // Cache Management
  // ============================================================================

  /**
   * Start periodic cache cleanup (remove expired entries)
   */
  private startCacheCleanup(): void {
    // Run cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredCache();
    }, 300000);
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupExpiredCache(): void {
    const now = Date.now();

    // Cleanup embeddings cache
    if (this.config.cache?.embeddings?.enabled) {
      const ttl = this.config.cache?.embeddings?.ttl ?? 3600000;
      for (const [key, entry] of this.embeddingCache.entries()) {
        if (now - entry.timestamp >= ttl) {
          this.embeddingCache.delete(key);
        }
      }
    }

    // Cleanup attributes cache
    if (this.config.cache?.attributes?.enabled) {
      const ttl = this.config.cache?.attributes?.ttl ?? 1800000;
      for (const [key, entry] of this.attributeCache.entries()) {
        if (now - entry.timestamp >= ttl) {
          this.attributeCache.delete(key);
        }
      }
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      embeddings: {
        size: this.embeddingCache.size,
        maxSize: this.config.cache?.embeddings?.maxSize ?? 1000,
        hits: this.cacheStats.embeddings.hits,
        misses: this.cacheStats.embeddings.misses,
        hitRate:
          this.cacheStats.embeddings.hits + this.cacheStats.embeddings.misses > 0
            ? (
              this.cacheStats.embeddings.hits /
              (this.cacheStats.embeddings.hits + this.cacheStats.embeddings.misses)
            ).toFixed(2)
            : '0.00',
      },
      attributes: {
        size: this.attributeCache.size,
        maxSize: this.config.cache?.attributes?.maxSize ?? 500,
        hits: this.cacheStats.attributes.hits,
        misses: this.cacheStats.attributes.misses,
        hitRate:
          this.cacheStats.attributes.hits + this.cacheStats.attributes.misses > 0
            ? (
              this.cacheStats.attributes.hits /
              (this.cacheStats.attributes.hits + this.cacheStats.attributes.misses)
            ).toFixed(2)
            : '0.00',
      },
    };
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.embeddingCache.clear();
    this.attributeCache.clear();
    this.cacheStats = {
      embeddings: { hits: 0, misses: 0 },
      attributes: { hits: 0, misses: 0 },
    };
  }

  /**
   * Get MongoDB collection
   */
  private async getCollection(): Promise<Collection<ProductDoc>> {
    const db = await this.ensureConnection();
    return db.collection(this.config.collection);
  }

  /**
   * Generate embedding for a single text
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    return this.embedText(text);
  }

  /**
   * Ingest products into the RAG system
   * Converts RAGDocuments to ProductDocs and indexes them with embeddings
   */
  async ingest(
    documents: RAGDocument[],
    options?: IngestOptions
  ): Promise<IngestResult> {
    const collection = await this.getCollection();

    let indexed = 0;
    let failed = 0;
    const errors: Array<{ id: string; error: string }> = [];

    try {
      // Process documents in batches for efficiency
      const batchSize = options?.batchSize || 10;

      for (let i = 0; i < documents.length; i += batchSize) {
        const batch = documents.slice(i, i + batchSize);

        // Generate embeddings for batch (include key attributes for better retrieval)
        const textsForEmbedding = batch.map(doc => {
          const metadata = doc.metadata || {};
          const attributeParts: string[] = [];

          // Include key product attributes in embedding
          const attributeFields = ['category', 'brand', 'color', 'material', 'size', 'gender', 'season'];
          for (const field of attributeFields) {
            if (metadata[field]) {
              const value = Array.isArray(metadata[field])
                ? metadata[field].join(', ')
                : metadata[field];
              attributeParts.push(`${field}: ${value}`);
            }
          }

          // Combine content with attributes
          return attributeParts.length > 0
            ? `${doc.content}. ${attributeParts.join(', ')}`
            : doc.content;
        });

        const embeddings = await this.generateEmbeddingsBatch(textsForEmbedding);

        // Convert RAGDocuments to ProductDocs
        const productDocs = batch.map((doc, idx) => {
          const metadata = doc.metadata || {};

          return {
            tenantId: this.config.tenantId,
            // Only set agentId if explicitly provided (agent-specific product)
            // Products without agentId are shared across all agents in tenant
            ...(options?.agentId ? { agentId: options.agentId } : {}),
            sku: doc.id,
            title: metadata.title || doc.content.substring(0, 100),
            description: metadata.description || doc.content,
            embedding: embeddings[idx],
            attributes: {
              category: metadata.category,
              brand: metadata.brand,
              color: metadata.color,
              material: metadata.material,
              size: metadata.size,
              gender: metadata.gender,
              season: metadata.season,
              price: metadata.price,
              ...metadata.attributes,
            },
            inStock: metadata.inStock !== false,
            metrics: metadata.metrics || {},
          };
        });

        // Insert or update documents
        try {
          if (options?.overwrite) {
            // Replace existing documents
            const bulkOps = productDocs.map(doc => ({
              replaceOne: {
                filter: {
                  tenantId: this.config.tenantId,
                  sku: doc.sku,
                  // Match by agentId if provided (for agent-specific products)
                  ...(options.agentId ? { agentId: options.agentId } : { agentId: { $exists: false } })
                },
                replacement: doc,
                upsert: true,
              },
            }));

            const result = await collection.bulkWrite(bulkOps);
            indexed += result.upsertedCount + result.modifiedCount;
          } else if (options?.skipExisting) {
            // Only insert new documents
            const existingSkus = await collection
              .find({
                tenantId: this.config.tenantId,
                sku: { $in: productDocs.map(d => d.sku) },
                // Check for matching products (shared or agent-specific)
                ...(options.agentId ? { agentId: options.agentId } : { agentId: { $exists: false } })
              })
              .project({ sku: 1 })
              .toArray();

            const existingSet = new Set(existingSkus.map(d => d.sku));
            const newDocs = productDocs.filter(d => !existingSet.has(d.sku));

            if (newDocs.length > 0) {
              const result = await collection.insertMany(newDocs);
              indexed += result.insertedCount;
            }

            failed += productDocs.length - newDocs.length;
          } else {
            // Default: upsert all
            const bulkOps = productDocs.map(doc => ({
              updateOne: {
                filter: {
                  tenantId: this.config.tenantId,
                  sku: doc.sku,
                  // Match by agentId if provided (for agent-specific products)
                  ...(options?.agentId ? { agentId: options.agentId } : { agentId: { $exists: false } })
                },
                update: { $set: doc },
                upsert: true,
              },
            }));

            const result = await collection.bulkWrite(bulkOps);
            indexed += result.upsertedCount + result.modifiedCount;
          }
        } catch (error: any) {
          batch.forEach(doc => {
            failed++;
            errors.push({
              id: doc.id,
              error: error.message || 'Unknown error during insertion',
            });
          });
        }
      }

      return {
        success: failed === 0,
        indexed,
        failed,
        errors: errors.length > 0 ? errors : undefined,
        metadata: {
          batchSize: options?.batchSize || 10,
          totalDocuments: documents.length,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        indexed,
        failed: documents.length - indexed,
        errors: [{
          id: 'batch',
          error: error.message || 'Unknown error during ingestion',
        }],
      };
    }
  }

  /**
   * Update a single product
   */
  async update(
    id: string,
    document: Partial<RAGDocument>,
    options?: IngestOptions
  ): Promise<void> {
    const collection = await this.getCollection();

    const update: any = {};
    const metadata = document.metadata || {};

    if (document.content) {
      // Build text for embedding including attributes
      const attributeParts: string[] = [];
      const attributeFields = ['category', 'brand', 'color', 'material', 'size', 'gender', 'season'];
      for (const field of attributeFields) {
        if (metadata[field]) {
          const value = Array.isArray(metadata[field])
            ? metadata[field].join(', ')
            : metadata[field];
          attributeParts.push(`${field}: ${value}`);
        }
      }

      const textForEmbedding = attributeParts.length > 0
        ? `${document.content}. ${attributeParts.join(', ')}`
        : document.content;

      // Generate new embedding with content + attributes
      const embedding = await this.generateEmbedding(textForEmbedding);
      update.embedding = embedding;
      update.description = document.content;
    }

    if (document.metadata) {
      // Update attributes from metadata

      if (metadata.title) update.title = metadata.title;
      if (metadata.inStock !== undefined) update.inStock = metadata.inStock;

      // Update nested attributes
      const attributeUpdates: any = {};
      const metricUpdates: any = {};

      const attributeFields = ['category', 'brand', 'color', 'material', 'size', 'gender', 'season', 'price'];
      attributeFields.forEach(field => {
        if (metadata[field] !== undefined) {
          attributeUpdates[`attributes.${field}`] = metadata[field];
        }
      });

      if (metadata.metrics) {
        Object.entries(metadata.metrics).forEach(([key, value]) => {
          metricUpdates[`metrics.${key}`] = value;
        });
      }

      Object.assign(update, attributeUpdates, metricUpdates);

      // Handle custom attributes
      if (metadata.attributes) {
        Object.entries(metadata.attributes).forEach(([key, value]) => {
          update[`attributes.${key}`] = value;
        });
      }
    }

    await collection.updateOne(
      {
        tenantId: this.config.tenantId,
        sku: id,
        // Match by agentId if provided, otherwise match shared products
        ...(options?.agentId ? { agentId: options.agentId } : { agentId: { $exists: false } })
      },
      { $set: update }
    );
  }

  /**
   * Delete product(s) by SKU
   */
  async delete(
    ids: string | string[],
    options?: IngestOptions
  ): Promise<number> {
    const collection = await this.getCollection();

    const skuArray = Array.isArray(ids) ? ids : [ids];

    const result = await collection.deleteMany({
      tenantId: this.config.tenantId,
      sku: { $in: skuArray },
      // Match by agentId if provided, otherwise match shared products
      ...(options?.agentId ? { agentId: options.agentId } : { agentId: { $exists: false } })
    });

    return result.deletedCount;
  }

  /**
   * Bulk operations for efficient batch processing
   */
  async bulk(
    operations: BulkOperation[],
    options?: IngestOptions
  ): Promise<BulkResult> {
    let inserted = 0;
    let updated = 0;
    let deleted = 0;
    let failed = 0;
    const errors: Array<{ id: string; operation: string; error: string }> = [];

    for (const op of operations) {
      try {
        switch (op.type) {
          case 'insert':
            if (op.document) {
              await this.ingest([op.document], options);
              inserted++;
            }
            break;

          case 'update':
            if (op.document) {
              await this.update(op.id, op.document, options);
              updated++;
            }
            break;

          case 'delete':
            const count = await this.delete(op.id, options);
            deleted += count;
            break;
        }
      } catch (error: any) {
        failed++;
        errors.push({
          id: op.id,
          operation: op.type,
          error: error.message || 'Unknown error',
        });
      }
    }

    return {
      success: failed === 0,
      inserted,
      updated,
      deleted,
      failed,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Generate embeddings for a batch of texts
   */
  private async generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    const cacheConfig = this.config.cache?.embeddings;

    for (const text of texts) {
      // Check cache first
      if (cacheConfig?.enabled) {
        const cached = this.embeddingCache.get(text);
        const ttl = cacheConfig.ttl ?? 3600000;
        if (cached && Date.now() - cached.timestamp < ttl) {
          embeddings.push(cached.value);
          this.cacheStats.embeddings.hits++;
          continue;
        }
      }

      // Generate embedding
      this.cacheStats.embeddings.misses++;
      const embedding = await this.generateEmbedding(text);
      embeddings.push(embedding);

      // Cache result
      if (cacheConfig?.enabled) {
        this.embeddingCache.set(text, {
          value: embedding,
          timestamp: Date.now(),
        });
      }
    }

    return embeddings;
  }

  /**
   * Ingest documents from URL source (CSV, JSON, XML, API)
   */
  async ingestFromUrl(
    source: URLSource,
    options?: IngestOptions
  ): Promise<URLIngestResult> {
    try {
      // Fetch data from URL using native fetch
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), source.timeout || 30000);

      const response = await fetch(source.url, {
        headers: {
          ...source.headers,
          ...(source.auth && this.buildAuthHeaders(source.auth)),
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
      }

      // Transform data to RAGDocuments
      let documents: RAGDocument[];

      if (source.type === 'json' || source.type === 'api') {
        const data = await response.json();
        documents = this.transformJsonToDocuments(data, source.transform);
      } else if (source.type === 'csv') {
        const data = await response.text();
        documents = await this.transformCsvToDocuments(data, source.transform);
      } else if (source.type === 'xml') {
        const data = await response.text();
        documents = await this.transformXmlToDocuments(data, source.transform);
      } else {
        throw new Error(`Unsupported source type: ${source.type}`);
      }

      // Add source metadata to all documents
      documents = documents.map(doc => ({
        ...doc,
        metadata: {
          ...doc.metadata,
          ...source.metadata,
          sourceUrl: source.url,
          fetchedAt: new Date().toISOString(),
        },
      }));

      // Ingest using standard ingest method
      const ingestResult = await this.ingest(documents, options);

      return {
        ...ingestResult,
        sourceUrl: source.url,
        fetchedAt: new Date(),
        documentsFetched: documents.length,
      };
    } catch (error) {
      console.error('URL ingestion failed:', error);
      return {
        success: false,
        indexed: 0,
        failed: 0,
        sourceUrl: source.url,
        fetchedAt: new Date(),
        documentsFetched: 0,
        errors: [{
          id: 'fetch',
          error: error instanceof Error ? error.message : 'Unknown error',
        }],
      };
    }
  }

  /**
   * Handle webhook payload for real-time updates
   */
  async handleWebhook(
    payload: any,
    source: string,
    options?: IngestOptions
  ): Promise<IngestResult> {
    try {
      // Parse webhook payload based on source
      let documents: RAGDocument[] = [];

      if (source === 'shopify') {
        documents = this.parseShopifyWebhook(payload);
      } else if (source === 'woocommerce') {
        documents = this.parseWooCommerceWebhook(payload);
      } else if (source === 'custom') {
        // Assume payload is already in RAGDocument format
        documents = Array.isArray(payload) ? payload : [payload];
      } else {
        throw new Error(`Unsupported webhook source: ${source}`);
      }

      // Add webhook metadata
      documents = documents.map(doc => ({
        ...doc,
        metadata: {
          ...doc.metadata,
          webhookSource: source,
          receivedAt: new Date().toISOString(),
        },
      }));

      // Ingest or update documents
      return await this.ingest(documents, { ...options, overwrite: true });
    } catch (error) {
      console.error('Webhook handling failed:', error);
      return {
        success: false,
        indexed: 0,
        failed: 1,
        errors: [{
          id: 'webhook',
          error: error instanceof Error ? error.message : 'Unknown error',
        }],
      };
    }
  }

  // ============================================================================
  // Private Helper Methods for URL Ingestion
  // ============================================================================

  private buildAuthHeaders(auth: URLSource['auth']): Record<string, string> {
    if (!auth) return {};

    if (auth.type === 'bearer' && auth.token) {
      return { Authorization: `Bearer ${auth.token}` };
    } else if (auth.type === 'basic' && auth.username && auth.password) {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      return { Authorization: `Basic ${encoded}` };
    } else if (auth.type === 'api-key' && auth.header && auth.key) {
      return { [auth.header]: auth.key };
    } else if (auth.type === 'custom' && auth.headers) {
      return auth.headers;
    }

    return {};
  }

  private transformJsonToDocuments(
    data: any,
    transform?: URLSource['transform']
  ): RAGDocument[] {
    // Apply JSONPath if provided
    let items = data;
    if (transform?.documentPath) {
      // Simple JSONPath implementation (can be enhanced with jsonpath-plus library)
      items = this.extractByPath(data, transform.documentPath);
    }

    // Ensure items is an array
    if (!Array.isArray(items)) {
      items = [items];
    }

    // Map fields
    return items.map((item: any, index: number) => {
      const fieldMapping = transform?.fieldMapping || {};

      // Build metadata from fieldMapping only (not entire raw item)
      const metadata: Record<string, any> = {};

      for (const [key, path] of Object.entries(fieldMapping)) {
        if (key !== 'id' && key !== 'content' && path && typeof path === 'string') {
          metadata[key] = this.extractField(item, path);
        }
      }

      return {
        id: this.extractField(item, fieldMapping.id as string || 'id') || `doc-${index}`,
        content: this.extractField(item, fieldMapping.content as string || 'content') || JSON.stringify(item),
        metadata,
      };
    });
  }

  private async transformCsvToDocuments(
    csvData: string,
    transform?: URLSource['transform']
  ): Promise<RAGDocument[]> {
    // Simple CSV parsing (can be enhanced with csv-parse library)
    const lines = csvData.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());

    return lines.slice(1).map((line, index) => {
      const values = line.split(',').map(v => v.trim());
      const item = headers.reduce((acc, header, i) => {
        acc[header] = values[i];
        return acc;
      }, {} as Record<string, string>);

      const fieldMapping = transform?.fieldMapping || {};

      // Build metadata from fieldMapping (consistent with JSON transform)
      const metadata: Record<string, any> = {};

      for (const [key, path] of Object.entries(fieldMapping)) {
        if (key !== 'id' && key !== 'content' && path && typeof path === 'string') {
          metadata[key] = this.extractField(item, path);
        }
      }

      return {
        id: this.extractField(item, fieldMapping.id as string || 'id') || `doc-${index}`,
        content: this.extractField(item, fieldMapping.content as string || 'content') || JSON.stringify(item),
        metadata,
      };
    });
  }

  private async transformXmlToDocuments(
    _xmlData: string,
    _transform?: URLSource['transform']
  ): Promise<RAGDocument[]> {
    // Placeholder for XML parsing (would use xml2js or similar)
    throw new Error('XML parsing not yet implemented. Please use JSON or CSV format.');
  }

  private extractByPath(data: any, path: string): any {
    // Simple JSONPath extraction (e.g., "$.products[*]")
    // In production, use a library like jsonpath-plus
    if (path.startsWith('$.')) {
      const parts = path.slice(2).split('.');
      let current = data;

      for (const part of parts) {
        if (part.endsWith('[*]')) {
          const key = part.slice(0, -3);
          current = current[key];
          if (!Array.isArray(current)) {
            throw new Error(`Path ${path} does not resolve to an array`);
          }
          return current;
        } else {
          current = current[part];
        }
      }

      return current;
    }

    return data;
  }

  private extractField(item: any, path: string): any {
    // Support nested field access (e.g., "variants[0].price")
    const parts = path.split('.');
    let current = item;

    for (const part of parts) {
      if (part.includes('[')) {
        const [key, index] = part.split('[');
        const idx = parseInt(index.replace(']', ''));
        current = current[key]?.[idx];
      } else {
        current = current[part];
      }

      if (current === undefined) return undefined;
    }

    return current;
  }

  private parseShopifyWebhook(payload: any): RAGDocument[] {
    // Parse Shopify product webhook
    return [{
      id: payload.id?.toString() || payload.handle,
      content: `${payload.title}\n${payload.body_html || ''}`,
      metadata: {
        title: payload.title,
        price: payload.variants?.[0]?.price,
        sku: payload.variants?.[0]?.sku,
        inStock: (payload.variants?.[0]?.inventory_quantity || 0) > 0,
        vendor: payload.vendor,
        product_type: payload.product_type,
        tags: payload.tags,
      },
    }];
  }

  private parseWooCommerceWebhook(payload: any): RAGDocument[] {
    // Parse WooCommerce product webhook
    return [{
      id: payload.id?.toString() || payload.sku,
      content: `${payload.name}\n${payload.description || ''}`,
      metadata: {
        title: payload.name,
        price: payload.price,
        sku: payload.sku,
        inStock: payload.stock_status === 'instock',
        categories: payload.categories?.map((c: any) => c.name),
      },
    }];
  }

  /**
   * Cleanup resources and close connections
   */
  async disconnect(): Promise<void> {
    // Stop the cache cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    // Close MongoDB connection
    await this.client.close();
    this.db = null;
  }
}


