import type {
  RAGPlugin,
  RAGContext,
  RAGDocument,
  IngestResult,
  IngestOptions,
} from '../types/plugins';

/**
 * Configuration for the default RAG plugin
 */
export interface DefaultRAGConfig {
  /**
   * API key for the embedding provider
   */
  embeddingProviderApiKey: string;

  /**
   * Embedding provider to use
   * @default 'openai'
   */
  embeddingProvider?: 'openai';

  /**
   * OpenAI embedding model
   * @default 'text-embedding-3-small'
   */
  embeddingModel?: string;

  /**
   * Number of results to return from search
   * @default 5
   */
  limit?: number;
}

/**
 * Simple document with embedding
 */
interface StoredDocument extends RAGDocument {
  embedding: number[];
  agentId: string;
  createdAt: Date;
}

/**
 * Default RAG Plugin
 * 
 * A minimal, zero-config RAG plugin that provides basic document storage,
 * embedding generation, and semantic search capabilities.
 * 
 * Features:
 * - In-memory vector storage (for simplicity)
 * - OpenAI embeddings
 * - Cosine similarity search
 * - Simple ingestion and retrieval
 * 
 * For production use cases with advanced features (attribute extraction,
 * rescoring, reranking, etc.), use specialized plugins like @snap-agent/rag-ecommerce
 */
export class DefaultRAGPlugin implements RAGPlugin {
  name = 'default-rag';
  type = 'rag' as const;

  private config: Required<DefaultRAGConfig>;
  private documents: Map<string, StoredDocument[]> = new Map();

  constructor(config: DefaultRAGConfig) {
    this.config = {
      embeddingProvider: config.embeddingProvider || 'openai',
      embeddingModel: config.embeddingModel || 'text-embedding-3-small',
      limit: config.limit || 5,
      embeddingProviderApiKey: config.embeddingProviderApiKey,
    };
  }

  /**
   * Retrieve context for a message using semantic search
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
    const agentDocs = this.documents.get(options.agentId) || [];

    if (agentDocs.length === 0) {
      return {
        content: '',
        sources: [],
        metadata: { count: 0 },
      };
    }

    // Generate embedding for query
    const queryEmbedding = await this.generateEmbedding(message);

    // Calculate cosine similarity for all documents
    const scoredDocs = agentDocs
      .map((doc) => ({
        ...doc,
        score: this.cosineSimilarity(queryEmbedding, doc.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.limit);

    // Format context
    const content = scoredDocs
      .map((doc, idx) => `[${idx + 1}] ${doc.content}`)
      .join('\n\n');

    return {
      content,
      sources: scoredDocs.map((doc) => ({
        id: doc.id,
        title: doc.metadata?.title,
        score: doc.score,
        type: 'document',
        ...doc.metadata,
      })),
      metadata: {
        count: scoredDocs.length,
        totalDocuments: agentDocs.length,
      },
    };
  }

  /**
   * Ingest documents into the RAG system
   */
  async ingest(
    documents: RAGDocument[],
    options?: IngestOptions
  ): Promise<IngestResult> {
    if (!options?.agentId) {
      return {
        success: false,
        indexed: 0,
        failed: documents.length,
        errors: [
          {
            id: 'batch',
            error: 'agentId is required for document ingestion',
          },
        ],
      };
    }

    let indexed = 0;
    const errors: Array<{ id: string; error: string }> = [];

    // Get or create document collection for this agent
    const agentDocs = this.documents.get(options.agentId) || [];

    for (const doc of documents) {
      try {
        // Generate embedding
        const embedding = await this.generateEmbedding(doc.content);

        // Check if document already exists
        const existingIdx = agentDocs.findIndex((d) => d.id === doc.id);

        const storedDoc: StoredDocument = {
          ...doc,
          embedding,
          agentId: options.agentId,
          createdAt: new Date(),
        };

        if (existingIdx >= 0) {
          if (options.overwrite) {
            // Replace existing
            agentDocs[existingIdx] = storedDoc;
            indexed++;
          } else if (!options.skipExisting) {
            // Default: upsert
            agentDocs[existingIdx] = storedDoc;
            indexed++;
          }
          // If skipExisting, do nothing
        } else {
          // New document
          agentDocs.push(storedDoc);
          indexed++;
        }
      } catch (error) {
        errors.push({
          id: doc.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // Update the collection
    this.documents.set(options.agentId, agentDocs);

    return {
      success: errors.length === 0,
      indexed,
      failed: errors.length,
      errors: errors.length > 0 ? errors : undefined,
      metadata: {
        totalDocuments: agentDocs.length,
      },
    };
  }

  /**
   * Update a single document
   */
  async update(
    id: string,
    document: Partial<RAGDocument>,
    options?: IngestOptions
  ): Promise<void> {
    if (!options?.agentId) {
      throw new Error('agentId is required for document update');
    }

    const agentDocs = this.documents.get(options.agentId) || [];
    const existingIdx = agentDocs.findIndex((d) => d.id === id);

    if (existingIdx < 0) {
      throw new Error(`Document not found: ${id}`);
    }

    const existing = agentDocs[existingIdx];

    // Update content and regenerate embedding if content changed
    if (document.content && document.content !== existing.content) {
      const embedding = await this.generateEmbedding(document.content);
      agentDocs[existingIdx] = {
        ...existing,
        ...document,
        content: document.content,
        embedding,
      };
    } else {
      // Just update metadata
      agentDocs[existingIdx] = {
        ...existing,
        ...document,
        id: existing.id, // Ensure ID doesn't change
        content: existing.content, // Ensure content doesn't change
        embedding: existing.embedding, // Keep existing embedding
      };
    }

    this.documents.set(options.agentId, agentDocs);
  }

  /**
   * Delete document(s) by ID
   */
  async delete(
    ids: string | string[],
    options?: IngestOptions
  ): Promise<number> {
    if (!options?.agentId) {
      throw new Error('agentId is required for document deletion');
    }

    const agentDocs = this.documents.get(options.agentId) || [];
    const idsArray = Array.isArray(ids) ? ids : [ids];

    const initialCount = agentDocs.length;
    const filtered = agentDocs.filter((doc) => !idsArray.includes(doc.id));
    const deletedCount = initialCount - filtered.length;

    this.documents.set(options.agentId, filtered);

    return deletedCount;
  }

  /**
   * Generate embedding using OpenAI
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.embeddingProviderApiKey}`,
      },
      body: JSON.stringify({
        model: this.config.embeddingModel,
        input: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.data[0].embedding;
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (normA * normB);
  }

  /**
   * Get statistics about stored documents
   */
  getStats(): Record<string, any> {
    const stats: Record<string, any> = {
      totalAgents: this.documents.size,
      agentStats: {},
    };

    for (const [agentId, docs] of this.documents.entries()) {
      stats.agentStats[agentId] = {
        documentCount: docs.length,
      };
    }

    return stats;
  }

  /**
   * Clear all documents for an agent
   */
  clearAgent(agentId: string): void {
    this.documents.delete(agentId);
  }

  /**
   * Clear all documents
   */
  clearAll(): void {
    this.documents.clear();
  }
}

