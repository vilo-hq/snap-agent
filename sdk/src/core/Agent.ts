import { randomUUID } from 'node:crypto';
import { generateText, streamText, Output, stepCountIs } from 'ai';
import type { UserModelMessage, AssistantModelMessage, Schema } from 'ai';
import { ProviderFactory } from '../providers';
import { PluginManager } from './PluginManager';
import { PluginRegistry } from './PluginRegistry';
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
  StoredPluginConfig,
} from '../types';
import type {
  URLSource,
  URLIngestResult,
} from '../types';
import type { TokenMetrics, RAGMetrics } from '../types/plugins';

// Type for messages accepted by the AI SDK
type AIMessage = UserModelMessage | AssistantModelMessage;

/** Optional system prompt builder (e.g. chat security sandwich with RAG ordering). */
export type BuildSystemPromptFn = (ctx: {
  instructions: string;
  ragContexts: string[];
}) => string;

export interface AgentGenerateOptions {
  useRAG?: boolean;
  ragFilters?: Record<string, any>;
  threadId?: string;
  /** Authenticated user behind the turn; threaded into analytics records. */
  userId?: string;
  /** Maximum number of tool-call round-trips before returning. Default: 5 */
  maxToolSteps?: number;
  /** When set, replaces default instructions + RAG concatenation. */
  buildSystemPrompt?: BuildSystemPromptFn;
  /** When true, tools are not passed to the provider. */
  disableTools?: boolean;
  /**
   * RAG metrics override for analytics. Use when RAG is retrieved outside the
   * SDK pipeline (e.g. the host prefetches context and passes `useRAG: false`):
   * the provided fields are merged over the SDK-computed base so the tracked
   * `rag` metric reflects the real retrieval instead of an empty one.
   */
  ragInfo?: Partial<RAGMetrics>;
}

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

function resolveSystemPromptAndRag(
  instructions: string,
  ragContexts: string[],
  buildSystemPrompt?: BuildSystemPromptFn,
): string {
  if (buildSystemPrompt) {
    return buildSystemPrompt({ instructions, ragContexts });
  }
  if (ragContexts.length > 0) {
    return instructions + '\n\n' + ragContexts.join('\n\n');
  }
  return instructions;
}

/** AI SDK usage shape varies by version (promptTokens/inputTokens). Normalize it. */
type AISDKUsage = {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

function toTokenMetrics(usage?: AISDKUsage): TokenMetrics {
  const promptTokens = usage?.promptTokens ?? usage?.inputTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? usage?.outputTokens ?? 0;
  const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

/** Best-effort classification of provider errors for analytics. */
function classifyLlmError(error: unknown): { errorType: string; isRetryable: boolean } {
  const err = error as { name?: string; statusCode?: number; message?: string };
  const status = err?.statusCode;
  const msg = (err?.message || '').toLowerCase();
  if (status === 429 || msg.includes('rate limit')) return { errorType: 'rate_limit', isRetryable: true };
  if (status === 401 || status === 403 || msg.includes('api key')) return { errorType: 'auth', isRetryable: false };
  if (msg.includes('timeout') || msg.includes('etimedout')) return { errorType: 'timeout', isRetryable: true };
  if (status != null && status >= 500) return { errorType: 'provider_error', isRetryable: true };
  return { errorType: err?.name || 'llm_error', isRetryable: false };
}

/** Own-managed retries for transient LLM errors (AI SDK internal retry is disabled so we can count them). */
const LLM_MAX_RETRIES = 2;

/**
 * Runs an LLM call, retrying on retryable provider errors up to LLM_MAX_RETRIES.
 * Returns the result plus how many retries it took (0 = succeeded first try) so callers
 * can surface a `retry` warning in analytics.
 */
async function callLlmWithRetry<R>(fn: () => Promise<R>): Promise<{ value: R; retryCount: number }> {
  let retryCount = 0;
  for (;;) {
    try {
      return { value: await fn(), retryCount };
    } catch (error) {
      const { isRetryable } = classifyLlmError(error);
      if (!isRetryable || retryCount >= LLM_MAX_RETRIES) throw error;
      retryCount += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** (retryCount - 1), 4000)));
    }
  }
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
   *
   * If plugins are provided, their configurations will be extracted (if they implement getConfig())
   * and stored in the database for later reinstantiation.
   */
  static async create(
    config: AgentConfig,
    storage: StorageAdapter,
    providerFactory: ProviderFactory
  ): Promise<Agent> {
    // Extract serializable configs from plugins (if they implement getConfig())
    const pluginConfigs: StoredPluginConfig[] = config.pluginConfigs || [];

    if (config.plugins && config.plugins.length > 0) {
      for (const plugin of config.plugins) {
        // Check if plugin implements getConfig() for serialization
        if ('getConfig' in plugin && typeof plugin.getConfig === 'function') {
          pluginConfigs.push({
            type: plugin.type,
            name: plugin.name,
            config: plugin.getConfig(),
            priority: plugin.priority,
            enabled: true,
          });
        }
      }
    }

    // Store agent with plugin configs
    const configWithPluginConfigs = {
      ...config,
      pluginConfigs,
    };

    const agentId = await storage.createAgent(configWithPluginConfigs);
    const data = await storage.getAgent(agentId);

    if (!data) {
      throw new AgentNotFoundError(agentId);
    }

    // Preserve runtime plugins from original config
    data.plugins = config.plugins || [];

    return new Agent(data, storage, providerFactory);
  }

  /**
   * Load an existing agent by ID
   *
   * Plugins can be attached in three ways (in order of priority):
   * 1. Direct plugins array - runtime plugin instances passed directly
   * 2. Plugin registry - reinstantiate from stored configs using registered factories
   * 3. No plugins - agent loads without plugin functionality
   *
   * @param agentId - The agent ID to load
   * @param storage - Storage adapter
   * @param providerFactory - Provider factory
   * @param options - Either:
   *   - Plugin[] array (legacy, for backwards compatibility)
   *   - Options object with plugins and/or registry
   */
  static async load(
    agentId: string,
    storage: StorageAdapter,
    providerFactory: ProviderFactory,
    options?: Plugin[] | {
      /** Direct plugin instances to attach */
      plugins?: Plugin[];
      /** Registry to reinstantiate plugins from stored configs */
      registry?: PluginRegistry;
    }
  ): Promise<Agent | null> {
    const data = await storage.getAgent(agentId);

    if (!data) {
      return null;
    }

    // Handle legacy signature: load(id, storage, factory, plugins[])
    if (Array.isArray(options)) {
      data.plugins = options;
      return new Agent(data, storage, providerFactory);
    }

    // New signature: load(id, storage, factory, { plugins?, registry? })
    // Priority 1: Direct plugins passed in options
    if (options?.plugins && options.plugins.length > 0) {
      data.plugins = options.plugins;
    }
    // Priority 2: Reinstantiate from stored configs using registry
    else if (options?.registry && data.pluginConfigs && data.pluginConfigs.length > 0) {
      try {
        data.plugins = await options.registry.instantiateAll(data.pluginConfigs);
      } catch (error) {
        console.error('Failed to reinstantiate plugins from stored configs:', error);
        throw error;
      }
    }
    // Priority 3: No plugins
    else {
      data.plugins = [];
    }

    return new Agent(data, storage, providerFactory);
  }

  /**
   * Update agent properties
   */
  async update(updates: Partial<AgentConfig>): Promise<void> {
    // Preserve current plugins before storage operation
    const currentPlugins = this.data.plugins || [];

    await this.storage.updateAgent(this.data.id, updates);

    // Reload data
    const updatedData = await this.storage.getAgent(this.data.id);
    if (updatedData) {
      // Restore plugins - they're runtime objects that can't be serialized to storage
      // If updates include new plugins, use those; otherwise keep current plugins
      updatedData.plugins = updates.plugins || currentPlugins;
      this.data = updatedData;

      // Rebuild plugin manager if plugins changed
      if (updates.plugins) {
        this.pluginManager = new PluginManager(updatedData.plugins);
      }
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
  async generateResponse<T = unknown>(
    messages: AIMessage[],
    options?: AgentGenerateOptions & {
      output?:
      | { mode: 'json' }                           // Flexible JSON (parsed manually)
      | { mode: 'object'; schema: Schema<T> }      // Structured object with Zod schema
    }
  ): Promise<{
    text: string;
    parsed?: T;  // Typed result when using 'object' mode, unknown for 'json' mode
    metadata?: Record<string, any>;
  }> {
    const startTime = Date.now();
    // Correlates the request/response/error analytics records of this single turn.
    const correlationId = randomUUID();

    // Track request in analytics plugins
    if (messages.length > 0) {
      await this.pluginManager.trackRequest({
        agentId: this.data.id,
        threadId: options?.threadId,
        userId: options?.userId,
        correlationId,
        message: extractTextContent(messages[messages.length - 1].content),
        timestamp: new Date(),
      });
    }

    // Execute middleware before request
    const beforeResult = await this.pluginManager.executeBeforeRequest(messages, {
      agentId: this.data.id,
      threadId: options?.threadId,
    });

    let ragContexts: string[] = [];
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

      ragContexts = contexts;
      ragMetadata = allMetadata;
    }

    const systemPrompt = resolveSystemPromptAndRag(
      this.data.instructions,
      ragContexts,
      options?.buildSystemPrompt,
    );

    // Generate response
    const model = await this.providerFactory.getModel(this.data.provider, this.data.model);
    const tools = options?.disableTools ? undefined : this.pluginManager.getAISDKTools();
    // When tools are available the model may need multiple steps to resolve
    // all tool calls before producing a final text answer.
    const stopWhen = tools
      ? stepCountIs(options?.maxToolSteps ?? 5)
      : undefined;

    let text: string;
    let parsed: T | undefined;
    let usage: AISDKUsage | undefined;
    let toolCalls: Array<{ toolName: string }> | undefined;
    let retryCount = 0;

    const llmStart = Date.now();
    try {
      if (options?.output?.mode === 'object') {
        // Structured object output using AI SDK's experimental_output
        // This validates the response against the schema and provides type safety
        const outputSchema = options.output.schema;
        const { value: result, retryCount: rc } = await callLlmWithRetry(() => generateText({
          model,
          messages: beforeResult.messages,
          system: systemPrompt,
          maxRetries: 0,
          ...(tools && { tools }),
          ...(stopWhen && { stopWhen }),
          experimental_output: Output.object({ schema: outputSchema }),
        }));
        retryCount = rc;
        text = JSON.stringify(result.experimental_output);
        parsed = result.experimental_output as T;
        usage = result.usage as AISDKUsage | undefined;
        toolCalls = result.toolCalls as Array<{ toolName: string }> | undefined;
      } else if (options?.output?.mode === 'json') {
        // Flexible JSON mode - add instruction and parse manually
        const jsonSystemPrompt = systemPrompt + '\n\n---\nOUTPUT FORMAT: You MUST respond with valid JSON only. No markdown code blocks, no explanations, no additional text - just raw JSON that can be parsed directly.';
        const { value: result, retryCount: rc } = await callLlmWithRetry(() => generateText({
          model,
          messages: beforeResult.messages,
          system: jsonSystemPrompt,
          maxRetries: 0,
          ...(tools && { tools }),
          ...(stopWhen && { stopWhen }),
        }));
        retryCount = rc;
        text = result.text;
        usage = result.usage as AISDKUsage | undefined;
        toolCalls = result.toolCalls as Array<{ toolName: string }> | undefined;
        try {
          parsed = JSON.parse(text) as T;
        } catch {
          // LLM didn't return valid JSON - leave parsed undefined
        }
      } else {
        // Default: plain text mode
        const { value: result, retryCount: rc } = await callLlmWithRetry(() => generateText({
          model,
          messages: beforeResult.messages,
          system: systemPrompt,
          maxRetries: 0,
          ...(tools && { tools }),
          ...(stopWhen && { stopWhen }),
        }));
        retryCount = rc;
        text = result.text;
        usage = result.usage as AISDKUsage | undefined;
        toolCalls = result.toolCalls as Array<{ toolName: string }> | undefined;
      }
    } catch (error) {
      const { errorType, isRetryable } = classifyLlmError(error);
      await this.pluginManager.trackError({
        agentId: this.data.id,
        threadId: options?.threadId,
        userId: options?.userId,
        correlationId,
        timestamp: new Date(),
        errorType,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        isRetryable,
        component: 'llm',
      });
      throw error;
    }
    const llmApiTime = Date.now() - llmStart;

    // Execute middleware after response
    const afterResult = await this.pluginManager.executeAfterResponse(text, {
      agentId: this.data.id,
      threadId: options?.threadId,
      metadata: beforeResult.metadata,
    });

    // Track response in analytics plugins
    const latency = Date.now() - startTime;
    const tokens = toTokenMetrics(usage);
    const rag: RAGMetrics = {
      enabled: ragContexts.length > 0 || !!options?.useRAG || !!options?.ragInfo,
      documentsRetrieved: ragContexts.length,
      sourcesCount: ragContexts.length,
      // Host-provided metrics (e.g. prefetched RAG) take precedence over the
      // SDK-computed base so analytics reflect the real retrieval.
      ...options?.ragInfo,
    };
    const warningReasons: string[] = [];
    if (retryCount > 0) warningReasons.push('retry');
    if (afterResult.response.trim().length === 0) warningReasons.push('empty_response');
    await this.pluginManager.trackResponseExtended({
      agentId: this.data.id,
      threadId: options?.threadId,
      userId: options?.userId,
      correlationId,
      response: afterResult.response,
      responseLength: afterResult.response.length,
      timestamp: new Date(),
      timings: { total: latency, llmApiTime },
      tokens,
      rag,
      success: true,
      model: this.data.model,
      provider: this.data.provider,
      ...(warningReasons.length > 0 && { warningReasons }),
    });

    return {
      text: afterResult.response,
      ...(parsed !== undefined && { parsed }),
      metadata: {
        ...afterResult.metadata,
        correlationId,
        ragMetadata,
        latency,
        tokenUsage: tokens,
        ...(toolCalls && toolCalls.length > 0 && {
          toolCalls: toolCalls.map((tc) => ({ toolName: tc.toolName })),
        }),
      },
    };
  }

  /**
   * Stream a text response with optional plugin support
   */
  async streamResponse(
    messages: AIMessage[],
    onChunk: (chunk: string) => void,
    onComplete?: (fullText: string, metadata?: Record<string, any>) => void | Promise<void>,
    onError?: (error: Error) => void | Promise<void>,
    options?: AgentGenerateOptions,
  ): Promise<void> {
    // Correlates the request/response/error analytics records of this single turn.
    const correlationId = randomUUID();
    try {
      const startTime = Date.now();

      // Track request in analytics plugins
      if (messages.length > 0) {
        await this.pluginManager.trackRequest({
          agentId: this.data.id,
          threadId: options?.threadId,
          userId: options?.userId,
          correlationId,
          message: extractTextContent(messages[messages.length - 1].content),
          timestamp: new Date(),
        });
      }

      // Execute middleware before request
      const beforeResult = await this.pluginManager.executeBeforeRequest(messages, {
        agentId: this.data.id,
        threadId: options?.threadId,
      });

      let ragContexts: string[] = [];
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

        ragContexts = contexts;
        ragMetadata = allMetadata;
      }

      const systemPrompt = resolveSystemPromptAndRag(
        this.data.instructions,
        ragContexts,
        options?.buildSystemPrompt,
      );

      // Stream response
      const model = await this.providerFactory.getModel(this.data.provider, this.data.model);
      const tools = options?.disableTools ? undefined : this.pluginManager.getAISDKTools();
      const stopWhen = tools
        ? stepCountIs(options?.maxToolSteps ?? 5)
        : undefined;

      const llmStart = Date.now();
      const startStream = () =>
        streamText({
          model,
          messages: beforeResult.messages,
          system: systemPrompt,
          maxRetries: 0,
          ...(tools && { tools }),
          ...(stopWhen && { stopWhen }),
        });

      // Retry only while no chunk has been emitted yet, so an established stream
      // is never restarted mid-flight. Once the first token lands we commit.
      let streamResult = startStream();
      let iterator = streamResult.textStream[Symbol.asyncIterator]();
      let firstResult: IteratorResult<string>;
      let retryCount = 0;
      for (;;) {
        try {
          firstResult = await iterator.next();
          break;
        } catch (error) {
          const { isRetryable } = classifyLlmError(error);
          if (!isRetryable || retryCount >= LLM_MAX_RETRIES) throw error;
          retryCount += 1;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(500 * 2 ** (retryCount - 1), 4000)),
          );
          streamResult = startStream();
          iterator = streamResult.textStream[Symbol.asyncIterator]();
        }
      }

      let fullText = '';
      let firstChunkAt: number | undefined;
      for (let result = firstResult; !result.done; result = await iterator.next()) {
        if (firstChunkAt === undefined) firstChunkAt = Date.now();
        fullText += result.value;
        onChunk(result.value);
      }

      // Token usage resolves after the stream is fully consumed
      let usage: AISDKUsage | undefined;
      try {
        usage = (await streamResult.usage) as AISDKUsage | undefined;
      } catch {
        // usage not available
      }

      // Execute middleware after response
      const afterResult = await this.pluginManager.executeAfterResponse(fullText, {
        agentId: this.data.id,
        threadId: options?.threadId,
        metadata: beforeResult.metadata,
      });

      // Track response in analytics plugins
      const latency = Date.now() - startTime;
      const tokens = toTokenMetrics(usage);
      const rag: RAGMetrics = {
        enabled: ragContexts.length > 0 || !!options?.useRAG || !!options?.ragInfo,
        documentsRetrieved: ragContexts.length,
        sourcesCount: ragContexts.length,
        // Host-provided metrics (e.g. prefetched RAG) take precedence over the
        // SDK-computed base so analytics reflect the real retrieval.
        ...options?.ragInfo,
      };
      const warningReasons: string[] = [];
      if (retryCount > 0) warningReasons.push('retry');
      if (afterResult.response.trim().length === 0) warningReasons.push('empty_response');
      await this.pluginManager.trackResponseExtended({
        agentId: this.data.id,
        threadId: options?.threadId,
        userId: options?.userId,
        correlationId,
        response: afterResult.response,
        responseLength: afterResult.response.length,
        timestamp: new Date(),
        timings: {
          total: latency,
          llmApiTime: Date.now() - llmStart,
          ...(firstChunkAt && { timeToFirstToken: firstChunkAt - llmStart }),
        },
        tokens,
        rag,
        success: true,
        model: this.data.model,
        provider: this.data.provider,
        ...(warningReasons.length > 0 && { warningReasons }),
      });

      if (onComplete) {
        await onComplete(afterResult.response, {
          ...afterResult.metadata,
          correlationId,
          ragMetadata,
          latency,
          tokenUsage: tokens,
        });
      }
    } catch (error) {
      const { errorType, isRetryable } = classifyLlmError(error);
      await this.pluginManager.trackError({
        agentId: this.data.id,
        threadId: options?.threadId,
        userId: options?.userId,
        correlationId,
        timestamp: new Date(),
        errorType,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        isRetryable,
        component: 'llm',
      });
      if (onError) {
        await onError(error instanceof Error ? error : new Error('Unknown error'));
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

