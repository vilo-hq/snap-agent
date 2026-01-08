import { Agent } from './Agent';
import { Thread } from './Thread';
import { ProviderFactory } from '../providers';
import { PluginRegistry } from './PluginRegistry';
import {
  ClientConfig,
  AgentConfig,
  ThreadConfig,
  ChatRequest,
  ChatResponse,
  StreamCallbacks,
  AgentData,
  ThreadData,
  InvalidConfigError,
  AgentNotFoundError,
  ThreadNotFoundError,
  Plugin,
} from '../types';
import { DefaultRAGPlugin } from '../inc';

/**
 * Main SDK Client for managing AI agents and conversations
 */
export class AgentClient {
  private storage: ClientConfig['storage'];
  private providerFactory: ProviderFactory;
  private providers: ClientConfig['providers'];
  private pluginRegistry?: PluginRegistry;

  constructor(config: ClientConfig) {
    this.validateConfig(config);

    this.storage = config.storage;
    this.providers = config.providers;
    this.providerFactory = new ProviderFactory(config.providers);
    this.pluginRegistry = config.pluginRegistry as PluginRegistry | undefined;
  }

  private validateConfig(config: ClientConfig): void {
    if (!config.storage) {
      throw new InvalidConfigError('Storage adapter is required');
    }

    if (!config.providers || Object.keys(config.providers).length === 0) {
      throw new InvalidConfigError('At least one provider must be configured');
    }
  }

  // ============================================================================
  // Agent Operations
  // ============================================================================

  /**
   * Create a new agent
   */
  async createAgent(config: Omit<AgentConfig, 'provider'> & { provider?: AgentConfig['provider'] }): Promise<Agent> {
    const agentConfig: AgentConfig = {
      ...config,
      provider: config.provider || 'openai',
    };

    // Auto-instantiate DefaultRAGPlugin if RAG is enabled and no RAG plugin provided
    if (agentConfig.rag?.enabled) {
      const hasRAGPlugin = agentConfig.plugins?.some(p => p.type === 'rag');

      if (!hasRAGPlugin) {
        // Determine which API key to use
        const embeddingProviderApiKey =
          agentConfig.rag.embeddingProviderApiKey ||
          this.providers.openai?.apiKey;

        if (!embeddingProviderApiKey) {
          throw new InvalidConfigError(
            'RAG requires an embedding provider API key. ' +
            'Either configure OpenAI provider or set rag.embeddingProviderApiKey'
          );
        }

        // Create default RAG plugin
        const defaultRAGPlugin = new DefaultRAGPlugin({
          embeddingProviderApiKey,
          embeddingProvider: agentConfig.rag.embeddingProvider,
          embeddingModel: agentConfig.rag.embeddingModel,
          limit: agentConfig.rag.limit,
        });

        // Add to plugins array
        agentConfig.plugins = [...(agentConfig.plugins || []), defaultRAGPlugin];
      }
    }

    return await Agent.create(agentConfig, this.storage, this.providerFactory);
  }

  /**
   * Get an agent by ID
   *
   * Plugin loading priority:
   * 1. Direct plugins array passed to this method
   * 2. Plugin registry (if configured) - reinstantiates from stored configs
   * 3. No plugins
   *
   * @param agentId - The agent ID to load
   * @param options - Either Plugin[] for backwards compatibility, or options object
   */
  async getAgent(
    agentId: string,
    options?: Plugin[] | {
      /** Direct plugin instances to attach (highest priority) */
      plugins?: Plugin[];
      /** Override the client's registry for this call */
      registry?: PluginRegistry;
    }
  ): Promise<Agent> {
    // Handle legacy signature: getAgent(id, plugins[])
    if (Array.isArray(options)) {
      const agent = await Agent.load(agentId, this.storage, this.providerFactory, options);
      if (!agent) {
        throw new AgentNotFoundError(agentId);
      }
      return agent;
    }

    // New signature: getAgent(id, { plugins?, registry? })
    const registry = options?.registry || this.pluginRegistry;
    const agent = await Agent.load(agentId, this.storage, this.providerFactory, {
      plugins: options?.plugins,
      registry,
    });

    if (!agent) {
      throw new AgentNotFoundError(agentId);
    }

    return agent;
  }

  /**
   * List agents for a user
   */
  async listAgents(userId: string, organizationId?: string): Promise<AgentData[]> {
    return await this.storage.listAgents(userId, organizationId);
  }

  /**
   * Delete an agent
   */
  async deleteAgent(agentId: string): Promise<void> {
    const agent = await this.getAgent(agentId);
    await agent.delete();
  }

  // ============================================================================
  // Thread Operations
  // ============================================================================

  /**
   * Create a new thread
   */
  async createThread(config: ThreadConfig): Promise<Thread> {
    // Verify agent exists
    await this.getAgent(config.agentId);

    return await Thread.create(config, this.storage);
  }

  /**
   * Get a thread by ID
   */
  async getThread(threadId: string | undefined): Promise<Thread> {
    if (!threadId) {
      throw new ThreadNotFoundError('Thread ID is required');
    }

    const thread = await Thread.load(threadId, this.storage);

    if (!thread) {
      throw new ThreadNotFoundError(threadId);
    }

    return thread;
  }

  /**
   * List threads by user or agent
   */
  async listThreads(filters: {
    userId?: string;
    agentId?: string;
    organizationId?: string;
  }): Promise<ThreadData[]> {
    return await this.storage.listThreads(filters);
  }

  /**
   * Delete a thread
   */
  async deleteThread(threadId: string): Promise<void> {
    const thread = await this.getThread(threadId);
    await thread.delete();
  }

  // ============================================================================
  // Chat Operations
  // ============================================================================

  /**
   * Send a message and get a response (non-streaming)
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Load thread and agent
    const thread = await this.getThread(request.threadId);
    const agent = await this.getAgent(thread.agentId);

    // Add user message to thread
    await thread.addMessage('user', request.message, request.attachments);

    // Get conversation context with configurable length
    const contextLength = request.contextLength ?? 20;
    const messages = await thread.getConversationContext(contextLength);

    // Generate response with plugin support
    const result = await agent.generateResponse(messages, {
      useRAG: request.useRAG,
      ragFilters: request.ragFilters,
      threadId: thread.id,
    });

    // Add assistant response to thread
    const messageId = await thread.addMessage('assistant', result.text);

    return {
      reply: result.text,
      messageId,
      threadId: thread.id,
      timestamp: new Date(),
      metadata: result.metadata,
    };
  }

  /**
   * Send a message and stream the response
   */
  async chatStream(
    request: ChatRequest,
    callbacks: StreamCallbacks
  ): Promise<void> {
    try {
      // Load thread and agent
      const thread = await this.getThread(request.threadId);
      const agent = await this.getAgent(thread.agentId);

      // Add user message to thread
      await thread.addMessage('user', request.message, request.attachments);

      // Get conversation context with configurable length
      const contextLength = request.contextLength ?? 20;
      const messages = await thread.getConversationContext(contextLength);

      // Stream response with plugin support
      await agent.streamResponse(
        messages,
        callbacks.onChunk,
        async (fullResponse: string, metadata?: Record<string, any>) => {
          // Add assistant response to thread
          await thread.addMessage('assistant', fullResponse);
          callbacks.onComplete(fullResponse, metadata);
        },
        callbacks.onError,
        {
          useRAG: request.useRAG,
          ragFilters: request.ragFilters,
          threadId: thread.id,
        }
      );
    } catch (error) {
      callbacks.onError(
        error instanceof Error ? error : new Error('Unknown error')
      );
    }
  }

  /**
   * Generate a name for a thread based on its first message
   */
  async generateThreadName(firstMessage: string): Promise<string> {
    // Use the first configured provider for this utility function
    const providers = this.providerFactory.getConfiguredProviders();
    if (providers.length === 0) {
      throw new InvalidConfigError('No providers configured');
    }

    const model = await this.providerFactory.getModel(providers[0], 'gpt-4o');

    const { generateText } = await import('ai');
    const { text } = await generateText({
      model,
      messages: [
        {
          role: 'user',
          content: `Generate a brief and clear title to identify this conversation thread, based solely on the following first user message:
"${firstMessage}"

Requirements:
- Maximum 4 words
- Specific and concise
- Avoid generic words like "query" or "question"
- Reflect the main topic
Return only the title without additional explanations.`,
        },
      ],
      temperature: 0.3,
    });

    return text.trim() || 'New Chat';
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get list of configured providers
   */
  getConfiguredProviders() {
    return this.providerFactory.getConfiguredProviders();
  }

  /**
   * Check if a provider is configured
   */
  isProviderConfigured(provider: string) {
    return this.providerFactory.isProviderConfigured(provider as any);
  }
}

