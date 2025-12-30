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

export type EmbeddingProvider = 'openai' | 'voyage';

export interface DocsRAGConfig {
  /**
   * API key for embedding provider
   */
  embeddingProviderApiKey: string;

  /**
   * Embedding provider to use
   * - 'openai': OpenAI text-embedding models (default)
   * - 'voyage': Voyage AI models (better multilingual support)
   * @default 'openai'
   */
  embeddingProvider?: EmbeddingProvider;

  /**
   * Embedding model
   * @default 'text-embedding-3-small' for OpenAI, 'voyage-3-lite' for Voyage
   */
  embeddingModel?: string;

  /**
   * Chunking strategy for documents
   * @default 'paragraph'
   */
  chunkingStrategy?: ChunkingStrategy;

  /**
   * Maximum chunk size in characters
   * @default 1000
   */
  maxChunkSize?: number;

  /**
   * Overlap between chunks in characters
   * @default 200
   */
  chunkOverlap?: number;

  /**
   * Number of results to return
   * @default 5
   */
  limit?: number;

  /**
   * Minimum similarity score (0-1)
   * @default 0.7
   */
  minSimilarity?: number;

  /**
   * Include code blocks in search
   * @default true
   */
  includeCode?: boolean;
}

export type ChunkingStrategy = 'paragraph' | 'sentence' | 'fixed' | 'markdown';

export interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
  embedding: number[];
  metadata: {
    title?: string;
    section?: string;
    type: 'text' | 'code' | 'heading';
    language?: string;
    startLine?: number;
    endLine?: number;
    [key: string]: any;
  };
  createdAt: Date;
}

// ============================================================================
// Documentation RAG Plugin
// ============================================================================

/**
 * Documentation RAG Plugin
 * 
 * Optimized for technical documentation, markdown files, and code.
 * 
 * Features:
 * - Smart chunking strategies (paragraph, sentence, markdown-aware)
 * - Code block extraction and indexing
 * - Section hierarchy awareness
 * - Heading-based context
 * - In-memory vector storage
 */
export class DocsRAGPlugin implements RAGPlugin {
  name = 'docs-rag';
  type = 'rag' as const;

  private config: Required<DocsRAGConfig>;
  private chunks: Map<string, DocumentChunk[]> = new Map();
  private documents: Map<string, RAGDocument> = new Map();

  constructor(config: DocsRAGConfig) {
    const provider = config.embeddingProvider || 'openai';

    // Set default model based on provider
    const defaultModel = provider === 'voyage'
      ? 'voyage-3-lite'
      : 'text-embedding-3-small';

    this.config = {
      embeddingProviderApiKey: config.embeddingProviderApiKey,
      embeddingProvider: provider,
      embeddingModel: config.embeddingModel || defaultModel,
      chunkingStrategy: config.chunkingStrategy || 'markdown',
      maxChunkSize: config.maxChunkSize || 1000,
      chunkOverlap: config.chunkOverlap || 200,
      limit: config.limit || 5,
      minSimilarity: config.minSimilarity || 0.7,
      includeCode: config.includeCode !== false,
    };
  }

  /**
   * Retrieve relevant documentation chunks for a query
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
    const agentChunks = this.chunks.get(options.agentId) || [];

    if (agentChunks.length === 0) {
      return {
        content: '',
        sources: [],
        metadata: { count: 0, strategy: this.config.chunkingStrategy },
      };
    }

    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(message);

    // Filter and score chunks
    let scoredChunks = agentChunks
      .map((chunk) => ({
        ...chunk,
        score: this.cosineSimilarity(queryEmbedding, chunk.embedding),
      }))
      .filter((chunk) => chunk.score >= this.config.minSimilarity);

    // Apply filters if provided
    if (options.filters) {
      if (options.filters.type) {
        scoredChunks = scoredChunks.filter(
          (c) => c.metadata.type === options.filters!.type
        );
      }
      if (options.filters.section) {
        scoredChunks = scoredChunks.filter(
          (c) => c.metadata.section?.toLowerCase().includes(options.filters!.section.toLowerCase())
        );
      }
    }

    // Sort by score and limit
    scoredChunks = scoredChunks
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.limit);

    // Format context with section headers
    const content = this.formatChunksToContext(scoredChunks);

    return {
      content,
      sources: scoredChunks.map((chunk) => ({
        id: chunk.id,
        documentId: chunk.documentId,
        title: chunk.metadata.title,
        section: chunk.metadata.section,
        type: chunk.metadata.type,
        score: chunk.score,
      })),
      metadata: {
        count: scoredChunks.length,
        totalChunks: agentChunks.length,
        strategy: this.config.chunkingStrategy,
        avgScore: scoredChunks.length > 0
          ? scoredChunks.reduce((sum, c) => sum + c.score, 0) / scoredChunks.length
          : 0,
      },
    };
  }

  /**
   * Format retrieved chunks into context string
   */
  private formatChunksToContext(chunks: Array<DocumentChunk & { score: number }>): string {
    if (chunks.length === 0) return '';

    const sections: string[] = [];
    let currentSection = '';

    for (const chunk of chunks) {
      // Add section header if different
      const section = chunk.metadata.section || 'General';
      if (section !== currentSection) {
        currentSection = section;
        sections.push(`\n## ${section}\n`);
      }

      // Format based on type
      if (chunk.metadata.type === 'code') {
        const lang = chunk.metadata.language || '';
        sections.push(`\`\`\`${lang}\n${chunk.content}\n\`\`\``);
      } else {
        sections.push(chunk.content);
      }
    }

    return sections.join('\n\n');
  }

  /**
   * Ingest documents with intelligent chunking
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
    const agentChunks = this.chunks.get(options.agentId) || [];

    for (const doc of documents) {
      try {
        // Store original document
        this.documents.set(`${options.agentId}:${doc.id}`, doc);

        // Chunk the document
        const chunks = this.chunkDocument(doc);

        // Generate embeddings for all chunks
        for (const chunk of chunks) {
          const embedding = await this.generateEmbedding(chunk.content);

          const storedChunk: DocumentChunk = {
            id: `${doc.id}-chunk-${agentChunks.length}`,
            documentId: doc.id,
            content: chunk.content,
            embedding,
            metadata: {
              ...doc.metadata,
              ...chunk.metadata,
            },
            createdAt: new Date(),
          };

          agentChunks.push(storedChunk);
        }

        indexed++;
      } catch (error) {
        errors.push({
          id: doc.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.chunks.set(options.agentId, agentChunks);

    return {
      success: errors.length === 0,
      indexed,
      failed: errors.length,
      errors: errors.length > 0 ? errors : undefined,
      metadata: {
        totalChunks: agentChunks.length,
        strategy: this.config.chunkingStrategy,
      },
    };
  }

  /**
   * Chunk a document based on configured strategy
   */
  private chunkDocument(doc: RAGDocument): Array<{
    content: string;
    metadata: { type: 'text' | 'code' | 'heading'; section?: string; language?: string };
  }> {
    const content = doc.content;
    const chunks: Array<{
      content: string;
      metadata: { type: 'text' | 'code' | 'heading'; section?: string; language?: string };
    }> = [];

    switch (this.config.chunkingStrategy) {
      case 'markdown':
        return this.chunkMarkdown(content, doc.metadata?.title);
      case 'paragraph':
        return this.chunkByParagraph(content);
      case 'sentence':
        return this.chunkBySentence(content);
      case 'fixed':
        return this.chunkFixed(content);
      default:
        return this.chunkByParagraph(content);
    }
  }

  /**
   * Markdown-aware chunking
   */
  private chunkMarkdown(content: string, docTitle?: string): Array<{
    content: string;
    metadata: { type: 'text' | 'code' | 'heading'; section?: string; language?: string };
  }> {
    const chunks: Array<{
      content: string;
      metadata: { type: 'text' | 'code' | 'heading'; section?: string; language?: string };
    }> = [];

    let currentSection = docTitle || 'Overview';
    const lines = content.split('\n');
    let currentChunk = '';
    let inCodeBlock = false;
    let codeLanguage = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check for code block
      if (line.startsWith('```')) {
        if (!inCodeBlock) {
          // Starting code block
          if (currentChunk.trim()) {
            chunks.push({
              content: currentChunk.trim(),
              metadata: { type: 'text', section: currentSection },
            });
            currentChunk = '';
          }
          inCodeBlock = true;
          codeLanguage = line.slice(3).trim();
        } else {
          // Ending code block
          if (this.config.includeCode && currentChunk.trim()) {
            chunks.push({
              content: currentChunk.trim(),
              metadata: { type: 'code', section: currentSection, language: codeLanguage },
            });
          }
          currentChunk = '';
          inCodeBlock = false;
          codeLanguage = '';
        }
        continue;
      }

      // Check for headings
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch && !inCodeBlock) {
        // Save current chunk
        if (currentChunk.trim()) {
          chunks.push({
            content: currentChunk.trim(),
            metadata: { type: 'text', section: currentSection },
          });
          currentChunk = '';
        }

        // Update section
        currentSection = headingMatch[2];

        // Add heading as its own chunk for searchability
        chunks.push({
          content: headingMatch[2],
          metadata: { type: 'heading', section: currentSection },
        });
        continue;
      }

      // Add line to current chunk
      currentChunk += line + '\n';

      // Check if chunk is too large
      if (currentChunk.length > this.config.maxChunkSize && !inCodeBlock) {
        chunks.push({
          content: currentChunk.trim(),
          metadata: { type: 'text', section: currentSection },
        });
        currentChunk = '';
      }
    }

    // Don't forget the last chunk
    if (currentChunk.trim()) {
      chunks.push({
        content: currentChunk.trim(),
        metadata: { type: inCodeBlock ? 'code' : 'text', section: currentSection },
      });
    }

    return chunks;
  }

  /**
   * Paragraph-based chunking
   */
  private chunkByParagraph(content: string): Array<{
    content: string;
    metadata: { type: 'text' | 'code' | 'heading'; section?: string };
  }> {
    const paragraphs = content.split(/\n\n+/);
    const chunks: Array<{
      content: string;
      metadata: { type: 'text' | 'code' | 'heading'; section?: string };
    }> = [];

    let currentChunk = '';

    for (const para of paragraphs) {
      if ((currentChunk + para).length > this.config.maxChunkSize) {
        if (currentChunk.trim()) {
          chunks.push({
            content: currentChunk.trim(),
            metadata: { type: 'text' },
          });
        }
        currentChunk = para;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + para;
      }
    }

    if (currentChunk.trim()) {
      chunks.push({
        content: currentChunk.trim(),
        metadata: { type: 'text' },
      });
    }

    return chunks;
  }

  /**
   * Sentence-based chunking
   */
  private chunkBySentence(content: string): Array<{
    content: string;
    metadata: { type: 'text' | 'code' | 'heading'; section?: string };
  }> {
    const sentences = content.split(/(?<=[.!?])\s+/);
    const chunks: Array<{
      content: string;
      metadata: { type: 'text' | 'code' | 'heading'; section?: string };
    }> = [];

    let currentChunk = '';

    for (const sentence of sentences) {
      if ((currentChunk + sentence).length > this.config.maxChunkSize) {
        if (currentChunk.trim()) {
          chunks.push({
            content: currentChunk.trim(),
            metadata: { type: 'text' },
          });
        }
        currentChunk = sentence;
      } else {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
      }
    }

    if (currentChunk.trim()) {
      chunks.push({
        content: currentChunk.trim(),
        metadata: { type: 'text' },
      });
    }

    return chunks;
  }

  /**
   * Fixed-size chunking with overlap
   */
  private chunkFixed(content: string): Array<{
    content: string;
    metadata: { type: 'text' | 'code' | 'heading'; section?: string };
  }> {
    const chunks: Array<{
      content: string;
      metadata: { type: 'text' | 'code' | 'heading'; section?: string };
    }> = [];

    const size = this.config.maxChunkSize;
    const overlap = this.config.chunkOverlap;

    for (let i = 0; i < content.length; i += size - overlap) {
      const chunk = content.slice(i, i + size);
      if (chunk.trim()) {
        chunks.push({
          content: chunk.trim(),
          metadata: { type: 'text' },
        });
      }
    }

    return chunks;
  }

  /**
   * Update a document (re-chunks and re-embeds)
   */
  async update(
    id: string,
    document: Partial<RAGDocument>,
    options?: IngestOptions
  ): Promise<void> {
    if (!options?.agentId) {
      throw new Error('agentId is required');
    }

    // Get original document BEFORE deletion
    const docKey = `${options.agentId}:${id}`;
    const existing = this.documents.get(docKey);

    if (!existing && !document.content) {
      throw new Error(`Document not found: ${id}`);
    }

    // Remove existing chunks for this document
    await this.delete(id, options);

    // Re-ingest with updated content
    const updatedDoc: RAGDocument = {
      id,
      content: document.content || existing?.content || '',
      metadata: {
        ...existing?.metadata,
        ...document.metadata,
      },
    };

    await this.ingest([updatedDoc], options);
  }

  /**
   * Delete document and its chunks
   */
  async delete(ids: string | string[], options?: IngestOptions): Promise<number> {
    if (!options?.agentId) {
      throw new Error('agentId is required');
    }

    const idsArray = Array.isArray(ids) ? ids : [ids];
    const agentChunks = this.chunks.get(options.agentId) || [];
    const initialCount = agentChunks.length;

    // Remove chunks belonging to the documents
    const filtered = agentChunks.filter(
      (chunk) => !idsArray.includes(chunk.documentId)
    );

    this.chunks.set(options.agentId, filtered);

    // Remove document references
    for (const id of idsArray) {
      this.documents.delete(`${options.agentId}:${id}`);
    }

    return initialCount - filtered.length;
  }

  /**
   * Generate embedding using configured provider (OpenAI or Voyage)
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    if (this.config.embeddingProvider === 'voyage') {
      return this.generateVoyageEmbedding(text);
    }
    return this.generateOpenAIEmbedding(text);
  }

  /**
   * Generate embedding using OpenAI
   */
  private async generateOpenAIEmbedding(text: string): Promise<number[]> {
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

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }

  /**
   * Generate embedding using Voyage AI
   */
  private async generateVoyageEmbedding(text: string): Promise<number[]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
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
      throw new Error(`Voyage API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
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
      totalAgents: this.chunks.size,
      strategy: this.config.chunkingStrategy,
      agentStats: {},
    };

    for (const [agentId, chunks] of this.chunks.entries()) {
      const byType = { text: 0, code: 0, heading: 0 };
      chunks.forEach((c) => {
        byType[c.metadata.type as keyof typeof byType]++;
      });

      stats.agentStats[agentId] = {
        totalChunks: chunks.length,
        byType,
      };
    }

    return stats;
  }

  /**
   * Clear all data for an agent
   */
  clearAgent(agentId: string): void {
    this.chunks.delete(agentId);
    // Remove documents for this agent
    for (const key of this.documents.keys()) {
      if (key.startsWith(`${agentId}:`)) {
        this.documents.delete(key);
      }
    }
  }

  /**
   * Clear all data
   */
  clearAll(): void {
    this.chunks.clear();
    this.documents.clear();
  }
}

