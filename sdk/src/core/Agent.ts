import { generateText, streamText } from 'ai';
import type { UserModelMessage, AssistantModelMessage } from 'ai';
import { ProviderFactory } from '../providers';
import { PluginManager } from './PluginManager';
import {
  AgentConfig,
  AgentData,
  AgentFile,
  StorageAdapter,
  AgentNotFoundError,
  Plugin,
  RAGDocument,
  IngestResult,
  IngestOptions,
  BulkOperation,
  BulkResult,
} from '../types';
import type {
  URLSource,
  URLIngestResult,
} from '../types';

// Type for messages accepted by the AI SDK
type AIMessage = UserModelMessage | AssistantModelMessage;

/**
 * Helper function to extract text content from a message
 */
function extractTextContent(content: AIMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  // If content is an array, extract text from text parts
  return content
    .map((part) => {
      if ('text' in part) {
        return part.text;
      }
      return '';
    })
    .filter(Boolean)
    .join(' ');
}

/**
 * Agent class representing an AI agent with persistent state
 */
export class Agent {
  private data: AgentData;
  private storage: StorageAdapter;
  private providerFactory: ProviderFactory;
  private pluginManager: PluginManager;

  constructor(
    data: AgentData,
    storage: StorageAdapter,
    providerFactory: ProviderFactory
  ) {
    this.data = data;
    this.storage = storage;
    this.providerFactory = providerFactory;
    this.pluginManager = new PluginManager(data.plugins || []);
  }

  /**
   * Create a new agent
   */
  static async create(
    config: AgentConfig,
    storage: StorageAdapter,
    providerFactory: ProviderFactory
  ): Promise<Agent> {
    const agentId = await storage.createAgent(config);
    const data = await storage.getAgent(agentId);

    if (!data) {
      throw new AgentNotFoundError(agentId);
    }

    return new Agent(data, storage, providerFactory);
  }

  /**
   * Load an existing agent by ID
   */
  static async load(
    agentId: string,
    storage: StorageAdapter,
    providerFactory: ProviderFactory
  ): Promise<Agent | null> {
    const data = await storage.getAgent(agentId);

    if (!data) {
      return null;
    }

    return new Agent(data, storage, providerFactory);
  }

  /**
   * Update agent properties
   */
  async update(updates: Partial<AgentConfig>): Promise<void> {
    await this.storage.updateAgent(this.data.id, updates);

    // Reload data
    const updatedData = await this.storage.getAgent(this.data.id);
    if (updatedData) {
      this.data = updatedData;
    }
  }

  /**
   * Delete this agent
   */
  async delete(): Promise<void> {
    await this.storage.deleteAgent(this.data.id);
  }

  /**
   * Add files to the agent
   */
  async addFiles(files: AgentFile[]): Promise<void> {
    // Update in storage (implementation depends on storage adapter)
    // For now, we'll update via the agent update
    const currentFiles = [...this.data.files, ...files];
    this.data.files = currentFiles;
    this.data.updatedAt = new Date();
  }

  /**
   * Generate a text response with optional plugin support
   */
  async generateResponse(
    messages: AIMessage[],
    options?: {
      useRAG?: boolean;
      ragFilters?: Record<string, any>;
      threadId?: string;
    }
  ): Promise<{
    text: string;
    metadata?: Record<string, any>;
  }> {
    const startTime = Date.now();

    // Track request in analytics plugins
    if (messages.length > 0) {
      await this.pluginManager.trackRequest({
        agentId: this.data.id,
        threadId: options?.threadId,
        message: extractTextContent(messages[messages.length - 1].content),
        timestamp: new Date(),
      });
    }

    // Execute middleware before request
    const beforeResult = await this.pluginManager.executeBeforeRequest(messages, {
      agentId: this.data.id,
      threadId: options?.threadId,
    });

    let systemPrompt = this.data.instructions;
    let ragMetadata: Record<string, any>[] = [];

    // Execute RAG plugins if enabled
    if (options?.useRAG && this.pluginManager.hasPluginsOfType('rag')) {
      const lastMessage = messages[messages.length - 1];
      const { contexts, allMetadata } = await this.pluginManager.executeRAG(
        extractTextContent(lastMessage.content),
        {
          agentId: this.data.id,
          threadId: options.threadId,
          filters: options.ragFilters,
        }
      );

      if (contexts.length > 0) {
        systemPrompt += '\n\n' + contexts.join('\n\n');
      }
      ragMetadata = allMetadata;
    }

    // Generate response
    const model = await this.providerFactory.getModel(this.data.provider, this.data.model);

    const { text } = await generateText({
      model,
      messages: beforeResult.messages,
      system: systemPrompt,
    });

    // Execute middleware after response
    const afterResult = await this.pluginManager.executeAfterResponse(text, {
      agentId: this.data.id,
      threadId: options?.threadId,
      metadata: beforeResult.metadata,
    });

    // Track response in analytics plugins
    const latency = Date.now() - startTime;
    await this.pluginManager.trackResponse({
      agentId: this.data.id,
      threadId: options?.threadId,
      response: afterResult.response,
      latency,
      timestamp: new Date(),
    });

    return {
      text: afterResult.response,
      metadata: {
        ...afterResult.metadata,
        ragMetadata,
        latency,
      },
    };
  }

  /**
   * Stream a text response with optional plugin support
   */
  async streamResponse(
    messages: AIMessage[],
    onChunk: (chunk: string) => void,
    onComplete?: (fullText: string, metadata?: Record<string, any>) => void,
    onError?: (error: Error) => void,
    options?: {
      useRAG?: boolean;
      ragFilters?: Record<string, any>;
      threadId?: string;
    }
  ): Promise<void> {
    try {
      const startTime = Date.now();

      // Track request in analytics plugins
      if (messages.length > 0) {
        await this.pluginManager.trackRequest({
          agentId: this.data.id,
          threadId: options?.threadId,
          message: extractTextContent(messages[messages.length - 1].content),
          timestamp: new Date(),
        });
      }

      // Execute middleware before request
      const beforeResult = await this.pluginManager.executeBeforeRequest(messages, {
        agentId: this.data.id,
        threadId: options?.threadId,
      });

      let systemPrompt = this.data.instructions;
      let ragMetadata: Record<string, any>[] = [];

      // Execute RAG plugins if enabled
      if (options?.useRAG && this.pluginManager.hasPluginsOfType('rag')) {
        const lastMessage = messages[messages.length - 1];
        const { contexts, allMetadata } = await this.pluginManager.executeRAG(
          extractTextContent(lastMessage.content),
          {
            agentId: this.data.id,
            threadId: options.threadId,
            filters: options.ragFilters,
          }
        );

        if (contexts.length > 0) {
          systemPrompt += '\n\n' + contexts.join('\n\n');
        }
        ragMetadata = allMetadata;
      }

      // Stream response
      const model = await this.providerFactory.getModel(this.data.provider, this.data.model);

      const { textStream } = streamText({
        model,
        messages: beforeResult.messages,
        system: systemPrompt,
      });

      let fullText = '';
      for await (const chunk of textStream) {
        fullText += chunk;
        onChunk(chunk);
      }

      // Execute middleware after response
      const afterResult = await this.pluginManager.executeAfterResponse(fullText, {
        agentId: this.data.id,
        threadId: options?.threadId,
        metadata: beforeResult.metadata,
      });

      // Track response in analytics plugins
      const latency = Date.now() - startTime;
      await this.pluginManager.trackResponse({
        agentId: this.data.id,
        threadId: options?.threadId,
        response: afterResult.response,
        latency,
        timestamp: new Date(),
      });

      if (onComplete) {
        onComplete(afterResult.response, {
          ...afterResult.metadata,
          ragMetadata,
          latency,
        });
      }
    } catch (error) {
      if (onError) {
        onError(error instanceof Error ? error : new Error('Unknown error'));
      } else {
        throw error;
      }
    }
  }

  /**
   * Get agent ID
   */
  get id(): string {
    return this.data.id;
  }

  /**
   * Get agent name
   */
  get name(): string {
    return this.data.name;
  }

  /**
   * Get agent instructions
   */
  get instructions(): string {
    return this.data.instructions;
  }

  /**
   * Get agent provider
   */
  get provider(): string {
    return this.data.provider;
  }

  /**
   * Get agent model
   */
  get model(): string {
    return this.data.model;
  }

  /**
   * Get all plugins attached to this agent
   */
  get plugins(): Plugin[] {
    return this.data.plugins || [];
  }

  /**
   * Add a plugin to this agent
   */
  addPlugin(plugin: Plugin): void {
    this.data.plugins = [...(this.data.plugins || []), plugin];
    this.pluginManager = new PluginManager(this.data.plugins);
    this.data.updatedAt = new Date();
  }

  /**
   * Remove a plugin by name
   */
  removePlugin(pluginName: string): void {
    this.data.plugins = (this.data.plugins || []).filter((p) => p.name !== pluginName);
    this.pluginManager = new PluginManager(this.data.plugins);
    this.data.updatedAt = new Date();
  }

  /**
   * Get all agent data
   */
  toJSON(): AgentData {
    return { ...this.data };
  }

  /**
   * Ingest documents into RAG plugins
   * Documents will be ingested into all RAG plugins that support ingestion
   */
  async ingestDocuments(
    documents: RAGDocument[],
    options?: IngestOptions
  ): Promise<IngestResult[]> {
    const ragPlugins = this.data.plugins?.filter(p => p.type === 'rag') || [];
    const results: IngestResult[] = [];

    for (const plugin of ragPlugins) {
      if ('ingest' in plugin && typeof plugin.ingest === 'function') {
        const result = await plugin.ingest(documents, {
          agentId: this.data.id,
          ...options,
        });
        results.push(result);
      }
    }

    if (results.length === 0) {
      throw new Error('No RAG plugins with ingestion support found');
    }

    return results;
  }

  /**
   * Update a document in RAG plugins
   */
  async updateDocument(
    id: string,
    document: Partial<RAGDocument>,
    options?: IngestOptions
  ): Promise<void> {
    const ragPlugins = this.data.plugins?.filter(p => p.type === 'rag') || [];
    let updated = false;

    for (const plugin of ragPlugins) {
      if ('update' in plugin && typeof plugin.update === 'function') {
        await plugin.update(id, document, {
          agentId: this.data.id,
          ...options,
        });
        updated = true;
      }
    }

    if (!updated) {
      throw new Error('No RAG plugins with update support found');
    }
  }

  /**
   * Delete documents from RAG plugins
   */
  async deleteDocuments(
    ids: string | string[],
    options?: IngestOptions
  ): Promise<number> {
    const ragPlugins = this.data.plugins?.filter(p => p.type === 'rag') || [];
    let totalDeleted = 0;

    for (const plugin of ragPlugins) {
      if ('delete' in plugin && typeof plugin.delete === 'function') {
        const count = await plugin.delete(ids, {
          agentId: this.data.id,
          ...options,
        });
        totalDeleted += count;
      }
    }

    return totalDeleted;
  }

  /**
   * Perform bulk operations on RAG plugins
   */
  async bulkDocumentOperations(
    operations: BulkOperation[],
    options?: IngestOptions
  ): Promise<BulkResult[]> {
    const ragPlugins = this.data.plugins?.filter(p => p.type === 'rag') || [];
    const results: BulkResult[] = [];

    for (const plugin of ragPlugins) {
      if ('bulk' in plugin && typeof plugin.bulk === 'function') {
        const result = await plugin.bulk(operations, {
          agentId: this.data.id,
          ...options,
        });
        results.push(result);
      }
    }

    if (results.length === 0) {
      throw new Error('No RAG plugins with bulk operation support found');
    }

    return results;
  }

  /**
   * Ingest documents from a URL source (CSV, JSON, XML, API)
   * Supports authentication, scheduling, and data transformation
   */
  async ingestFromUrl(
    source: URLSource,
    options?: IngestOptions
  ): Promise<URLIngestResult[]> {
    const ragPlugins = this.data.plugins?.filter(p => p.type === 'rag') || [];
    const results: URLIngestResult[] = [];

    for (const plugin of ragPlugins) {
      if ('ingestFromUrl' in plugin && typeof plugin.ingestFromUrl === 'function') {
        const result = await plugin.ingestFromUrl(source, {
          agentId: this.data.id,
          ...options,
        });
        results.push(result);
      }
    }

    if (results.length === 0) {
      throw new Error('No RAG plugins with URL ingestion support found');
    }

    return results;
  }

  /**
   * Handle webhook payload for real-time document updates
   * Useful for product inventory updates, price changes, etc.
   */
  async handleWebhook(
    payload: any,
    source: string,
    options?: IngestOptions
  ): Promise<IngestResult[]> {
    const ragPlugins = this.data.plugins?.filter(p => p.type === 'rag') || [];
    const results: IngestResult[] = [];

    for (const plugin of ragPlugins) {
      if ('handleWebhook' in plugin && typeof plugin.handleWebhook === 'function') {
        const result = await plugin.handleWebhook(payload, source, {
          agentId: this.data.id,
          ...options,
        });
        results.push(result);
      }
    }

    if (results.length === 0) {
      throw new Error('No RAG plugins with webhook support found');
    }

    return results;
  }
}

