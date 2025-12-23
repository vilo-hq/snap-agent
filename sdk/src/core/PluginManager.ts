import type {
  Plugin,
  RAGPlugin,
  ToolPlugin,
  MiddlewarePlugin,
  AnalyticsPlugin,
} from '../types/plugins';

/**
 * Plugin Manager
 * Manages and orchestrates plugin execution for agents
 */
export class PluginManager {
  private plugins: Plugin[];

  constructor(plugins: Plugin[] = []) {
    // Sort by priority (lower = executed first)
    this.plugins = plugins.sort((a, b) => {
      const aPriority = a.priority ?? 100;
      const bPriority = b.priority ?? 100;
      return aPriority - bPriority;
    });
  }

  // ============================================================================
  // Plugin Getters by Type
  // ============================================================================

  getRAGPlugins(): RAGPlugin[] {
    return this.plugins.filter((p) => p.type === 'rag') as RAGPlugin[];
  }

  getToolPlugins(): ToolPlugin[] {
    return this.plugins.filter((p) => p.type === 'tool') as ToolPlugin[];
  }

  getMiddlewarePlugins(): MiddlewarePlugin[] {
    return this.plugins.filter((p) => p.type === 'middleware') as MiddlewarePlugin[];
  }

  getAnalyticsPlugins(): AnalyticsPlugin[] {
    return this.plugins.filter((p) => p.type === 'analytics') as AnalyticsPlugin[];
  }

  getAllPlugins(): Plugin[] {
    return [...this.plugins];
  }

  // ============================================================================
  // RAG Plugin Execution
  // ============================================================================

  /**
   * Execute all RAG plugins and merge their contexts
   * Returns an array of context strings, one per plugin
   */
  async executeRAG(
    message: string,
    options: {
      agentId: string;
      threadId?: string;
      filters?: Record<string, any>;
      metadata?: Record<string, any>;
    }
  ): Promise<{
    contexts: string[];
    allMetadata: Record<string, any>[];
  }> {
    const ragPlugins = this.getRAGPlugins();

    if (ragPlugins.length === 0) {
      return { contexts: [], allMetadata: [] };
    }

    const results = await Promise.all(
      ragPlugins.map(async (plugin) => {
        try {
          const context = await plugin.retrieveContext(message, options);
          const formattedContext = plugin.formatContext
            ? plugin.formatContext(context)
            : context.content;

          return {
            context: formattedContext,
            metadata: context.metadata || {},
            pluginName: plugin.name,
          };
        } catch (error) {
          console.error(`RAG plugin "${plugin.name}" failed:`, error);
          return {
            context: '',
            metadata: { error: error instanceof Error ? error.message : 'Unknown error' },
            pluginName: plugin.name,
          };
        }
      })
    );

    return {
      contexts: results.map((r) => r.context).filter(Boolean),
      allMetadata: results.map((r) => ({ [r.pluginName]: r.metadata })),
    };
  }

  // ============================================================================
  // Middleware Plugin Execution
  // ============================================================================

  /**
   * Execute all middleware plugins before request
   */
  async executeBeforeRequest(
    messages: any[],
    context: { agentId: string; threadId?: string }
  ): Promise<{ messages: any[]; metadata?: any }> {
    const middlewarePlugins = this.getMiddlewarePlugins();

    let result: { messages: any[]; metadata?: any } = { messages, metadata: {} };

    for (const plugin of middlewarePlugins) {
      if (plugin.beforeRequest) {
        try {
          const pluginResult = await plugin.beforeRequest(result.messages, context);
          result = { ...result, ...pluginResult };
        } catch (error) {
          console.error(`Middleware plugin "${plugin.name}" beforeRequest failed:`, error);
        }
      }
    }

    return result;
  }

  /**
   * Execute all middleware plugins after response
   */
  async executeAfterResponse(
    response: string,
    context: { agentId: string; threadId?: string; metadata?: any }
  ): Promise<{ response: string; metadata?: any }> {
    const middlewarePlugins = this.getMiddlewarePlugins();

    let result: { response: string; metadata?: any } = { response, metadata: context.metadata };

    for (const plugin of middlewarePlugins) {
      if (plugin.afterResponse) {
        try {
          const pluginResult = await plugin.afterResponse(result.response, context);
          result = { ...result, ...pluginResult };
        } catch (error) {
          console.error(`Middleware plugin "${plugin.name}" afterResponse failed:`, error);
        }
      }
    }

    return result;
  }

  // ============================================================================
  // Analytics Plugin Execution
  // ============================================================================

  /**
   * Track request in all analytics plugins
   */
  async trackRequest(data: {
    agentId: string;
    threadId?: string;
    message: string;
    timestamp: Date;
  }): Promise<void> {
    const analyticsPlugins = this.getAnalyticsPlugins();

    await Promise.all(
      analyticsPlugins.map(async (plugin) => {
        try {
          await plugin.trackRequest(data);
        } catch (error) {
          console.error(`Analytics plugin "${plugin.name}" trackRequest failed:`, error);
        }
      })
    );
  }

  /**
   * Track response in all analytics plugins
   */
  async trackResponse(data: {
    agentId: string;
    threadId?: string;
    response: string;
    latency: number;
    tokensUsed?: number;
    timestamp: Date;
  }): Promise<void> {
    const analyticsPlugins = this.getAnalyticsPlugins();

    await Promise.all(
      analyticsPlugins.map(async (plugin) => {
        try {
          await plugin.trackResponse(data);
        } catch (error) {
          console.error(`Analytics plugin "${plugin.name}" trackResponse failed:`, error);
        }
      })
    );
  }

  // ============================================================================
  // Plugin Management
  // ============================================================================

  /**
   * Check if any plugins of a specific type exist
   */
  hasPluginsOfType(type: Plugin['type']): boolean {
    return this.plugins.some((p) => p.type === type);
  }

  /**
   * Get plugin by name
   */
  getPluginByName(name: string): Plugin | undefined {
    return this.plugins.find((p) => p.name === name);
  }
}


