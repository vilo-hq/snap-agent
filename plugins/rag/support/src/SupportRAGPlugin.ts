import type {
  RAGPlugin,
  RAGContext,
  RAGDocument,
  IngestResult,
  IngestOptions,
} from '@snap-agent/core';

// ============================================================================
// Types
// ============================================================================

export interface SupportRAGConfig {
  /**
   * API key for embedding provider
   */
  embeddingProviderApiKey: string;

  /**
   * Embedding provider to use
   * @default 'openai'
   */
  embeddingProvider?: 'openai';

  /**
   * Embedding model
   * @default 'text-embedding-3-small'
   */
  embeddingModel?: string;

  /**
   * Number of results to return
   * @default 5
   */
  limit?: number;

  /**
   * Minimum similarity score (0-1)
   * @default 0.65
   */
  minSimilarity?: number;

  /**
   * Boost factor for resolved tickets (they often have solutions)
   * @default 1.2
   */
  resolvedBoost?: number;

  /**
   * Boost factor for FAQ entries
   * @default 1.3
   */
  faqBoost?: number;

  /**
   * Include ticket history in context
   * @default true
   */
  includeHistory?: boolean;

  /**
   * Max ticket age to consider (days, 0 = no limit)
   * @default 365
   */
  maxTicketAgeDays?: number;
}

export type TicketStatus = 'open' | 'pending' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface SupportTicket {
  id: string;
  subject: string;
  description: string;
  resolution?: string;
  status: TicketStatus;
  priority?: TicketPriority;
  category?: string;
  tags?: string[];
  customerId?: string;
  agentId?: string;
  createdAt: Date;
  resolvedAt?: Date;
  messages?: Array<{
    role: 'customer' | 'agent' | 'system';
    content: string;
    timestamp: Date;
  }>;
}

export interface FAQEntry {
  id: string;
  question: string;
  answer: string;
  category?: string;
  tags?: string[];
  helpful?: number;
  notHelpful?: number;
}

export type SupportDocument = 
  | { type: 'ticket'; data: SupportTicket }
  | { type: 'faq'; data: FAQEntry }
  | { type: 'article'; data: RAGDocument };

interface StoredSupportDoc {
  id: string;
  type: 'ticket' | 'faq' | 'article';
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
  createdAt: Date;
}

// ============================================================================
// Support RAG Plugin
// ============================================================================

/**
 * Customer Support RAG Plugin
 * 
 * Optimized for customer support scenarios with tickets, FAQs, and help articles.
 * 
 * Features:
 * - Support ticket indexing with conversation history
 * - FAQ semantic search
 * - Resolution-based boosting (resolved tickets rank higher)
 * - Category and tag filtering
 * - Time-based filtering
 * - In-memory vector storage
 */
export class SupportRAGPlugin implements RAGPlugin {
  name = 'support-rag';
  type = 'rag' as const;

  private config: Required<SupportRAGConfig>;
  private documents: Map<string, StoredSupportDoc[]> = new Map();

  constructor(config: SupportRAGConfig) {
    this.config = {
      embeddingProviderApiKey: config.embeddingProviderApiKey,
      embeddingProvider: config.embeddingProvider || 'openai',
      embeddingModel: config.embeddingModel || 'text-embedding-3-small',
      limit: config.limit || 5,
      minSimilarity: config.minSimilarity || 0.65,
      resolvedBoost: config.resolvedBoost || 1.2,
      faqBoost: config.faqBoost || 1.3,
      includeHistory: config.includeHistory !== false,
      maxTicketAgeDays: config.maxTicketAgeDays || 365,
    };
  }

  /**
   * Retrieve relevant support context for a query
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

    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(message);

    // Filter by age if configured
    const cutoffDate = this.config.maxTicketAgeDays > 0
      ? new Date(Date.now() - this.config.maxTicketAgeDays * 24 * 60 * 60 * 1000)
      : null;

    // Score and filter documents
    let scoredDocs = agentDocs
      .filter((doc) => {
        // Age filter
        if (cutoffDate && doc.createdAt < cutoffDate) return false;
        return true;
      })
      .map((doc) => {
        let score = this.cosineSimilarity(queryEmbedding, doc.embedding);

        // Apply boosts
        if (doc.type === 'faq') {
          score *= this.config.faqBoost;
        } else if (doc.type === 'ticket' && doc.metadata.status === 'resolved') {
          score *= this.config.resolvedBoost;
        }

        return { ...doc, score };
      })
      .filter((doc) => doc.score >= this.config.minSimilarity);

    // Apply filters
    if (options.filters) {
      if (options.filters.type) {
        scoredDocs = scoredDocs.filter((d) => d.type === options.filters!.type);
      }
      if (options.filters.category) {
        scoredDocs = scoredDocs.filter(
          (d) => d.metadata.category?.toLowerCase() === options.filters!.category.toLowerCase()
        );
      }
      if (options.filters.status) {
        scoredDocs = scoredDocs.filter(
          (d) => d.metadata.status === options.filters!.status
        );
      }
      if (options.filters.tags && Array.isArray(options.filters.tags)) {
        scoredDocs = scoredDocs.filter((d) =>
          options.filters!.tags.some((tag: string) =>
            d.metadata.tags?.includes(tag)
          )
        );
      }
    }

    // Sort and limit
    scoredDocs = scoredDocs
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.limit);

    // Format context
    const content = this.formatSupportContext(scoredDocs);

    return {
      content,
      sources: scoredDocs.map((doc) => ({
        id: doc.id,
        type: doc.type,
        score: doc.score,
        category: doc.metadata.category,
        status: doc.metadata.status,
        ...doc.metadata,
      })),
      metadata: {
        count: scoredDocs.length,
        totalDocuments: agentDocs.length,
        byType: {
          faq: scoredDocs.filter((d) => d.type === 'faq').length,
          ticket: scoredDocs.filter((d) => d.type === 'ticket').length,
          article: scoredDocs.filter((d) => d.type === 'article').length,
        },
      },
    };
  }

  /**
   * Format support documents into context
   */
  private formatSupportContext(
    docs: Array<StoredSupportDoc & { score: number }>
  ): string {
    if (docs.length === 0) return '';

    const sections: string[] = [];

    // Group by type
    const faqs = docs.filter((d) => d.type === 'faq');
    const tickets = docs.filter((d) => d.type === 'ticket');
    const articles = docs.filter((d) => d.type === 'article');

    // FAQs first (most authoritative)
    if (faqs.length > 0) {
      sections.push('## Frequently Asked Questions\n');
      for (const faq of faqs) {
        sections.push(`**Q: ${faq.metadata.question}**`);
        sections.push(`A: ${faq.content}\n`);
      }
    }

    // Then resolved tickets (have solutions)
    const resolvedTickets = tickets.filter((t) => t.metadata.status === 'resolved');
    if (resolvedTickets.length > 0) {
      sections.push('## Similar Resolved Issues\n');
      for (const ticket of resolvedTickets) {
        sections.push(`### ${ticket.metadata.subject}`);
        sections.push(`**Problem:** ${ticket.metadata.description}`);
        if (ticket.metadata.resolution) {
          sections.push(`**Solution:** ${ticket.metadata.resolution}`);
        }
        sections.push('');
      }
    }

    // Help articles
    if (articles.length > 0) {
      sections.push('## Related Help Articles\n');
      for (const article of articles) {
        sections.push(article.content);
        sections.push('');
      }
    }

    return sections.join('\n');
  }

  /**
   * Ingest support documents
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
        errors: [{ id: 'batch', error: 'agentId is required' }],
      };
    }

    let indexed = 0;
    const errors: Array<{ id: string; error: string }> = [];
    const agentDocs = this.documents.get(options.agentId) || [];

    for (const doc of documents) {
      try {
        // Parse document type from metadata
        const docType = doc.metadata?.type || 'article';
        let content: string;
        let metadata: Record<string, any>;

        if (docType === 'ticket') {
          content = this.formatTicketForEmbedding(doc);
          metadata = {
            type: 'ticket',
            subject: doc.metadata?.subject,
            description: doc.metadata?.description,
            resolution: doc.metadata?.resolution,
            status: doc.metadata?.status || 'open',
            priority: doc.metadata?.priority,
            category: doc.metadata?.category,
            tags: doc.metadata?.tags,
          };
        } else if (docType === 'faq') {
          content = `${doc.metadata?.question || ''}\n${doc.content}`;
          metadata = {
            type: 'faq',
            question: doc.metadata?.question,
            category: doc.metadata?.category,
            tags: doc.metadata?.tags,
            helpful: doc.metadata?.helpful,
          };
        } else {
          content = doc.content;
          metadata = {
            type: 'article',
            title: doc.metadata?.title,
            category: doc.metadata?.category,
            tags: doc.metadata?.tags,
          };
        }

        // Generate embedding
        const embedding = await this.generateEmbedding(content);

        // Check for existing
        const existingIdx = agentDocs.findIndex((d) => d.id === doc.id);

        const storedDoc: StoredSupportDoc = {
          id: doc.id,
          type: docType as 'ticket' | 'faq' | 'article',
          content,
          embedding,
          metadata,
          createdAt: new Date(doc.metadata?.createdAt || Date.now()),
        };

        if (existingIdx >= 0) {
          agentDocs[existingIdx] = storedDoc;
        } else {
          agentDocs.push(storedDoc);
        }

        indexed++;
      } catch (error) {
        errors.push({
          id: doc.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

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
   * Format ticket for embedding (combines all relevant text)
   */
  private formatTicketForEmbedding(doc: RAGDocument): string {
    const parts: string[] = [];

    if (doc.metadata?.subject) {
      parts.push(`Subject: ${doc.metadata.subject}`);
    }

    if (doc.metadata?.description || doc.content) {
      parts.push(`Issue: ${doc.metadata?.description || doc.content}`);
    }

    if (doc.metadata?.resolution) {
      parts.push(`Resolution: ${doc.metadata.resolution}`);
    }

    if (doc.metadata?.category) {
      parts.push(`Category: ${doc.metadata.category}`);
    }

    // Include recent messages if available and configured
    if (this.config.includeHistory && doc.metadata?.messages) {
      const recentMessages = doc.metadata.messages.slice(-5);
      for (const msg of recentMessages) {
        parts.push(`${msg.role}: ${msg.content}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Specialized method to ingest tickets
   */
  async ingestTickets(
    tickets: SupportTicket[],
    options?: IngestOptions
  ): Promise<IngestResult> {
    const documents: RAGDocument[] = tickets.map((ticket) => ({
      id: ticket.id,
      content: ticket.description,
      metadata: {
        type: 'ticket',
        subject: ticket.subject,
        description: ticket.description,
        resolution: ticket.resolution,
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category,
        tags: ticket.tags,
        customerId: ticket.customerId,
        messages: ticket.messages,
        createdAt: ticket.createdAt,
        resolvedAt: ticket.resolvedAt,
      },
    }));

    return this.ingest(documents, options);
  }

  /**
   * Specialized method to ingest FAQs
   */
  async ingestFAQs(
    faqs: FAQEntry[],
    options?: IngestOptions
  ): Promise<IngestResult> {
    const documents: RAGDocument[] = faqs.map((faq) => ({
      id: faq.id,
      content: faq.answer,
      metadata: {
        type: 'faq',
        question: faq.question,
        category: faq.category,
        tags: faq.tags,
        helpful: faq.helpful,
        notHelpful: faq.notHelpful,
      },
    }));

    return this.ingest(documents, options);
  }

  /**
   * Update a document
   */
  async update(
    id: string,
    document: Partial<RAGDocument>,
    options?: IngestOptions
  ): Promise<void> {
    if (!options?.agentId) {
      throw new Error('agentId is required');
    }

    const agentDocs = this.documents.get(options.agentId) || [];
    const existingIdx = agentDocs.findIndex((d) => d.id === id);

    if (existingIdx < 0) {
      throw new Error(`Document not found: ${id}`);
    }

    const existing = agentDocs[existingIdx];

    // Rebuild and re-embed if content changed
    const newContent = document.content || existing.content;
    const embedding = document.content
      ? await this.generateEmbedding(newContent)
      : existing.embedding;

    agentDocs[existingIdx] = {
      ...existing,
      content: newContent,
      embedding,
      metadata: {
        ...existing.metadata,
        ...document.metadata,
      },
    };

    this.documents.set(options.agentId, agentDocs);
  }

  /**
   * Delete documents
   */
  async delete(ids: string | string[], options?: IngestOptions): Promise<number> {
    if (!options?.agentId) {
      throw new Error('agentId is required');
    }

    const idsArray = Array.isArray(ids) ? ids : [ids];
    const agentDocs = this.documents.get(options.agentId) || [];
    const initialCount = agentDocs.length;

    const filtered = agentDocs.filter((doc) => !idsArray.includes(doc.id));
    this.documents.set(options.agentId, filtered);

    return initialCount - filtered.length;
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
   * Calculate cosine similarity
   */
  private cosineSimilarity(a: number[], b: number[]): number {
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

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (normA * normB);
  }

  /**
   * Get statistics
   */
  getStats(): Record<string, any> {
    const stats: Record<string, any> = {
      totalAgents: this.documents.size,
      agentStats: {},
    };

    for (const [agentId, docs] of this.documents.entries()) {
      const byType = { ticket: 0, faq: 0, article: 0 };
      const byStatus = { open: 0, pending: 0, resolved: 0, closed: 0 };

      docs.forEach((d) => {
        byType[d.type as keyof typeof byType]++;
        if (d.type === 'ticket' && d.metadata.status) {
          byStatus[d.metadata.status as keyof typeof byStatus]++;
        }
      });

      stats.agentStats[agentId] = {
        totalDocuments: docs.length,
        byType,
        ticketsByStatus: byStatus,
      };
    }

    return stats;
  }

  /**
   * Clear agent data
   */
  clearAgent(agentId: string): void {
    this.documents.delete(agentId);
  }

  /**
   * Clear all data
   */
  clearAll(): void {
    this.documents.clear();
  }
}

